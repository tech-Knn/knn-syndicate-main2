import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import {
  assignChannel,
  processQueue,
  releaseChannelForCampaign,
  rolloverChannels,
  seedChannels,
} from './channel.service.js';

const suffix = Date.now().toString(36);
const chPrefix = `ct-${suffix}-`;
let orgId = '';
let buyerId = '';
let chCounter = 0;

async function makeChannels(n: number): Promise<void> {
  await seedChannels(Array.from({ length: n }, () => `${chPrefix}${chCounter++}`));
}

async function makeCampaign(status: string): Promise<string> {
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: { orgId, buyerId, name: `ch-camp-${Math.random()}`, status: status as never, keywords: [] },
    }),
  );
  return c.id;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Chan Co', slug: `chan-${suffix}` } });
    orgId = org.id;
    const buyer = await tx.user.create({
      data: { orgId, email: `chan-${suffix}@a.com`, name: 'Buyer', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
    });
    buyerId = buyer.id;
  });
});

beforeEach(async () => {
  // Isolate each test: clear this suite's channels + the org's queue/assignments/campaigns.
  await withSystem(async (tx) => {
    await tx.campaignQueue.deleteMany({ where: { orgId } });
    await tx.channelAssignment.deleteMany({ where: { orgId } });
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId: { startsWith: chPrefix } } });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.campaignQueue.deleteMany({ where: { orgId } });
    await tx.channelAssignment.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId: { startsWith: chPrefix } } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('channel pool', () => {
  it('100 concurrent assignments take 100 DISTINCT channels (zero double-assignment)', async () => {
    await makeChannels(120);
    const campaignIds = await Promise.all(Array.from({ length: 100 }, () => makeCampaign('APPROVED')));

    const results = await Promise.all(campaignIds.map((id) => assignChannel(id)));

    const refs = results.filter((r) => r.assigned).map((r) => r.channelRef);
    expect(refs).toHaveLength(100);
    expect(new Set(refs).size).toBe(100); // every campaign got a different channel

    // No channel is held by more than one campaign.
    const dupes = await withSystem((tx) =>
      tx.$queryRawUnsafe<{ current_campaign_id: string; n: bigint }[]>(
        `SELECT current_campaign_id, COUNT(*) n FROM channels
         WHERE status = 'ASSIGNED' AND channel_id LIKE '${chPrefix}%'
         GROUP BY current_campaign_id HAVING COUNT(*) > 1`,
      ),
    );
    expect(dupes).toHaveLength(0);
  });

  it('queues overflow FIFO and assigns the oldest waiter when a channel frees', async () => {
    await makeChannels(2);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await makeCampaign('APPROVED'));
    for (const id of ids) await assignChannel(id);

    const camps = await withSystem((tx) =>
      tx.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }),
    );
    const processing = camps.filter((c) => c.status === 'PROCESSING').map((c) => c.id);
    const queuedCamps = camps.filter((c) => c.status === 'QUEUED_NO_CHANNEL').map((c) => c.id);
    expect(processing).toHaveLength(2); // first two
    expect(queuedCamps).toHaveLength(3); // last three

    const queue = await withSystem((tx) =>
      tx.campaignQueue.findMany({ where: { status: 'WAITING' }, orderBy: { enqueuedAt: 'asc' }, select: { campaignId: true } }),
    );
    expect(queue.map((q) => q.campaignId)).toEqual([ids[2], ids[3], ids[4]]); // FIFO

    // Free the first campaign's channel → the oldest waiter (ids[2]) should get it.
    await releaseChannelForCampaign(ids[0]!);
    const revived = await withSystem((tx) => tx.campaign.findUnique({ where: { id: ids[2]! }, select: { status: true, channelId: true } }));
    expect(revived?.status).toBe('PROCESSING');
    expect(revived?.channelId).toBeTruthy();

    const remaining = await withSystem((tx) =>
      tx.campaignQueue.findMany({ where: { status: 'WAITING' }, orderBy: { enqueuedAt: 'asc' }, select: { campaignId: true } }),
    );
    expect(remaining.map((q) => q.campaignId)).toEqual([ids[3], ids[4]]);
  });

  it('rollover releases channels from non-holding campaigns and renews active ones', async () => {
    await makeChannels(2);
    const active = await makeCampaign('ACTIVE');
    const paused = await makeCampaign('PAUSED');
    await assignChannel(active); // holds (stays ACTIVE — ACTIVE→PROCESSING isn't applied)
    await assignChannel(paused); // holds (stays PAUSED)

    // Backdate the active campaign's lock to a previous IST day.
    await withSystem((tx) => tx.channel.updateMany({ where: { currentCampaignId: active }, data: { lockedForDay: '2000-01-01' } }));

    const res = await rolloverChannels('2000-01-02');
    expect(res.released).toBe(1); // the PAUSED campaign's channel
    expect(res.renewed).toBe(1); // the ACTIVE campaign's lock

    const pausedAfter = await withSystem((tx) => tx.campaign.findUnique({ where: { id: paused }, select: { channelId: true } }));
    expect(pausedAfter?.channelId).toBeNull();
    const activeAfter = await withSystem((tx) => tx.campaign.findUnique({ where: { id: active }, select: { channelId: true } }));
    expect(activeAfter?.channelId).toBeTruthy();

    // The active campaign now has two attribution spans (prior day closed, today open).
    const spans = await withSystem((tx) => tx.channelAssignment.findMany({ where: { campaignId: active }, orderBy: { assignedAt: 'asc' } }));
    expect(spans).toHaveLength(2);
    expect(spans.filter((s) => s.releasedAt === null)).toHaveLength(1);
  });

  it('processQueue is a no-op when the pool is empty', async () => {
    const id = await makeCampaign('APPROVED');
    await assignChannel(id); // no channels → queued
    expect(await processQueue()).toBe(0);
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id }, select: { status: true } }));
    expect(c?.status).toBe('QUEUED_NO_CHANNEL');
  });
});
