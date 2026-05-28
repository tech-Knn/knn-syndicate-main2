import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { encryptToken } from '@knn/fb';
import { ROLES, USER_STATUS } from '@knn/shared';
import {
  assignChannel,
  assignForCampaign,
  processQueue,
  releaseChannelForCampaign,
  rolloverChannels,
  seedChannels,
} from './channel.service.js';

const suffix = Date.now().toString(36);
const chPrefix = `ct-${suffix}-`;
let orgId = '';
let buyerId = '';
let afsId = '';
let domA = '';
let domB = '';
let chCounter = 0;

async function makeChannels(n: number): Promise<void> {
  await seedChannels(Array.from({ length: n }, () => `${chPrefix}${chCounter++}`));
}

/** Create `n` channels tagged to a domain's allocation (Phase E per-offer pool). */
async function makeDomainChannels(domainId: string, n: number): Promise<void> {
  await withSystem((tx) =>
    tx.channel.createMany({
      data: Array.from({ length: n }, () => ({ channelId: `${chPrefix}${chCounter++}`, domainId, status: 'AVAILABLE' as const })),
    }),
  );
}

/** A campaign with PAID offers across the given domains (Phase E). */
async function makeOfferCampaign(domainIds: string[]): Promise<string> {
  return withSystem(async (tx) => {
    const c = await tx.campaign.create({ data: { orgId, buyerId, name: `off-${Math.random()}`, status: 'APPROVED' as never, keywords: [] } });
    for (const domainId of domainIds) {
      await tx.offer.create({ data: { orgId, campaignId: c.id, domainId, weightPct: 50, kind: 'PAID' } });
    }
    return c.id;
  });
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
    afsId = (await tx.googleConnection.create({
      data: {
        accessTokenEnc: encryptToken('x'),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
        adsenseAccount: `acc-${suffix}`,
        adsenseAdClient: `adc-${suffix}`,
        afsPubId: `partner-pub-${suffix}`,
        label: 'AFS',
        status: 'ACTIVE',
      },
    })).id;
    domA = (await tx.domain.create({ data: { host: `a-${suffix}.example.com`, afsAccountId: afsId, status: 'LIVE', verifyToken: `va-${suffix}` } })).id;
    domB = (await tx.domain.create({ data: { host: `b-${suffix}.example.com`, afsAccountId: afsId, status: 'LIVE', verifyToken: `vb-${suffix}` } })).id;
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
    await tx.campaign.deleteMany({ where: { orgId } }); // cascades offers
    await tx.channel.deleteMany({ where: { channelId: { startsWith: chPrefix } } });
    await tx.domain.deleteMany({ where: { afsAccountId: afsId } });
    await tx.googleConnection.deleteMany({ where: { id: afsId } });
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
    // `released`/`renewed` are GLOBAL counts — a concurrently-running api-package test can
    // leave foreign channels in the shared DB, so assert "at least mine" + verify the rest
    // on this test's own campaigns below (robust to cross-package contention).
    expect(res.released).toBeGreaterThanOrEqual(1); // ≥ the PAUSED campaign's channel
    expect(res.renewed).toBeGreaterThanOrEqual(1); // ≥ the ACTIVE campaign's lock

    const pausedAfter = await withSystem((tx) => tx.campaign.findUnique({ where: { id: paused }, select: { channelId: true } }));
    expect(pausedAfter?.channelId).toBeNull();
    const activeAfter = await withSystem((tx) => tx.campaign.findUnique({ where: { id: active }, select: { channelId: true } }));
    expect(activeAfter?.channelId).toBeTruthy();

    // The active campaign now has two attribution spans (prior day closed, today open).
    const spans = await withSystem((tx) => tx.channelAssignment.findMany({ where: { campaignId: active }, orderBy: { assignedAt: 'asc' } }));
    expect(spans).toHaveLength(2);
    expect(spans.filter((s) => s.releasedAt === null)).toHaveLength(1);
  });

  it('leaves a queued campaign queued when the pool is empty', async () => {
    const id = await makeCampaign('APPROVED');
    await assignChannel(id); // no channels → queued
    await processQueue(); // (global count not asserted — the shared DB may hold foreign waiters)
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id }, select: { status: true } }));
    expect(c?.status).toBe('QUEUED_NO_CHANNEL'); // this campaign specifically stays queued
  });

  it('legacy assignChannel never grabs a domain-tagged channel', async () => {
    await makeDomainChannels(domA, 2); // only domain channels available, no global
    const id = await makeCampaign('APPROVED');
    const r = await assignChannel(id);
    expect(r.assigned).toBe(false); // no GLOBAL channel → queued, domain channels untouched
    const held = await withSystem((tx) => tx.channel.count({ where: { domainId: domA, status: 'ASSIGNED' } }));
    expect(held).toBe(0);
  });
});

describe('per-offer channel assignment (Phase E)', () => {
  it('assigns each PAID offer a channel from ITS OWN domain pool', async () => {
    await makeDomainChannels(domA, 1);
    await makeDomainChannels(domB, 1);
    const id = await makeOfferCampaign([domA, domB]);

    const r = await assignForCampaign(id);
    expect(r.assigned).toBe(true);
    expect(r.channelRefs).toHaveLength(2);

    const offers = await withSystem((tx) => tx.offer.findMany({ where: { campaignId: id } }));
    // Each offer holds a channel, and each channel belongs to that offer's domain.
    for (const o of offers) {
      expect(o.channelRef).toBeTruthy();
      const ch = await withSystem((tx) => tx.channel.findUnique({ where: { id: o.channelRef! }, select: { domainId: true, status: true, currentCampaignId: true } }));
      expect(ch?.domainId).toBe(o.domainId);
      expect(ch?.status).toBe('ASSIGNED');
      expect(ch?.currentCampaignId).toBe(id);
    }
    const camp = await withSystem((tx) => tx.campaign.findUnique({ where: { id }, select: { status: true } }));
    expect(camp?.status).toBe('PROCESSING');
  });

  it('is all-or-nothing: one exhausted domain pool → queued, zero channels held', async () => {
    await makeDomainChannels(domA, 1); // domA has a channel, domB has none
    const id = await makeOfferCampaign([domA, domB]);

    const r = await assignForCampaign(id);
    expect(r.assigned).toBe(false);

    const camp = await withSystem((tx) => tx.campaign.findUnique({ where: { id }, select: { status: true } }));
    expect(camp?.status).toBe('QUEUED_NO_CHANNEL');
    // The domA channel must NOT have been claimed (rolled back).
    const assigned = await withSystem((tx) => tx.channel.count({ where: { currentCampaignId: id } }));
    expect(assigned).toBe(0);
    const offersWithCh = await withSystem((tx) => tx.offer.count({ where: { campaignId: id, channelRef: { not: null } } }));
    expect(offersWithCh).toBe(0);
  });

  it('release frees every offer channel and clears the offer refs', async () => {
    await makeDomainChannels(domA, 1);
    await makeDomainChannels(domB, 1);
    const id = await makeOfferCampaign([domA, domB]);
    await assignForCampaign(id);

    await releaseChannelForCampaign(id);
    const stillHeld = await withSystem((tx) => tx.channel.count({ where: { currentCampaignId: id } }));
    expect(stillHeld).toBe(0);
    const refsLeft = await withSystem((tx) => tx.offer.count({ where: { campaignId: id, channelRef: { not: null } } }));
    expect(refsLeft).toBe(0);
  });

  it('two offer campaigns racing on a 1-channel domain → exactly one wins', async () => {
    await makeDomainChannels(domA, 1); // single channel in domA's pool
    const [c1, c2] = await Promise.all([makeOfferCampaign([domA]), makeOfferCampaign([domA])]);

    const [r1, r2] = await Promise.all([assignForCampaign(c1), assignForCampaign(c2)]);
    const winners = [r1, r2].filter((r) => r.assigned);
    expect(winners).toHaveLength(1); // zero double-assignment across offers/campaigns

    const claimed = await withSystem((tx) => tx.channel.count({ where: { domainId: domA, status: 'ASSIGNED' } }));
    expect(claimed).toBe(1);
  });
});
