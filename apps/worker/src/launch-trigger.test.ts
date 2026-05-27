import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { type FbLaunchJob, runFbLaunch, triggerAutoLaunch } from './launch-trigger.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';

interface CampaignShape {
  channelId?: string | null;
  fbCampaignId?: string | null;
}

async function makeCampaign({ channelId = null, fbCampaignId = null }: CampaignShape = {}): Promise<string> {
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: `AL ${Math.random()}`,
        status: 'PROCESSING',
        keywords: [],
        channelId,
        fbCampaignId,
      },
    }),
  );
  return c.id;
}

async function setOrgAutoLaunch(value: boolean): Promise<void> {
  await withSystem((tx) => tx.organization.update({ where: { id: orgId }, data: { autoLaunch: value } }));
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'AL Co', slug: `al-${suffix}`, autoLaunch: true } });
    orgId = org.id;
    const buyer = await tx.user.create({
      data: { orgId, email: `al-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
    });
    buyerId = buyer.id;
  });
});

beforeEach(async () => {
  await setOrgAutoLaunch(true);
  await withSystem((tx) => tx.campaign.deleteMany({ where: { orgId } }));
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('triggerAutoLaunch', () => {
  it('enqueues a launch when the org auto-launches and the campaign holds a channel but is not on FB', async () => {
    const id = await makeCampaign({ channelId: randomUUID() });
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(id, { enqueueLaunch });

    expect(res.enqueued).toBe(true);
    expect(enqueueLaunch).toHaveBeenCalledTimes(1);
    expect(enqueueLaunch).toHaveBeenCalledWith(id);
  });

  it('does NOT enqueue when the org has auto-launch off (manual gate)', async () => {
    await setOrgAutoLaunch(false);
    const id = await makeCampaign({ channelId: randomUUID() });
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(id, { enqueueLaunch });

    expect(res.enqueued).toBe(false);
    expect(enqueueLaunch).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when the campaign has no channel yet', async () => {
    const id = await makeCampaign({ channelId: null });
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(id, { enqueueLaunch });

    expect(res.enqueued).toBe(false);
    expect(enqueueLaunch).not.toHaveBeenCalled();
  });

  it('is idempotent — does NOT re-enqueue a campaign already on Facebook', async () => {
    const id = await makeCampaign({ channelId: randomUUID(), fbCampaignId: 'fbcamp-123' });
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(id, { enqueueLaunch });

    expect(res.enqueued).toBe(false);
    expect(enqueueLaunch).not.toHaveBeenCalled();
  });

  it('does NOT enqueue for a missing campaign', async () => {
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(randomUUID(), { enqueueLaunch });

    expect(res.enqueued).toBe(false);
    expect(enqueueLaunch).not.toHaveBeenCalled();
  });
});

describe('runFbLaunch', () => {
  const job: FbLaunchJob = { campaignId: 'camp-1' };

  it('POSTs the internal launch endpoint with the shared token and returns the status', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ACTIVE' }), { status: 200 }));

    const res = await runFbLaunch(job, {
      fetch: fetchMock as unknown as typeof fetch,
      token: 'secret-token',
      baseUrl: 'http://api:3000',
    });

    expect(res.status).toBe('ACTIVE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://api:3000/api/internal/launch/camp-1', {
      method: 'POST',
      headers: { 'x-internal-token': 'secret-token' },
    });
  });

  it('throws on a non-2xx response so BullMQ retries', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));

    await expect(
      runFbLaunch(job, { fetch: fetchMock as unknown as typeof fetch, token: 'secret-token', baseUrl: 'http://api:3000' }),
    ).rejects.toThrow(/internal launch failed \(500\)/);
  });

  it('throws when the internal token is not configured', async () => {
    const fetchMock = vi.fn();

    await expect(
      runFbLaunch(job, { fetch: fetchMock as unknown as typeof fetch, token: '', baseUrl: 'http://api:3000' }),
    ).rejects.toThrow(/INTERNAL_API_TOKEN is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
