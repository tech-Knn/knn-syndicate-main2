import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { type FbLaunchJob, enqueueFbLaunch, launchJobId, learnRcTermsNow, runFbLaunch, syncAllFbConnections, triggerAutoLaunch } from './launch-trigger.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';
let afsId = '';
let domA = '';
let domB = '';

interface CampaignShape {
  channelId?: string | null;
  fbCampaignId?: string | null;
  /** Whop campaigns (D33) are launched or not by their own id + status, never by `fbCampaignId`. */
  adProvider?: 'FACEBOOK' | 'WHOP';
  whopCampaignId?: string | null;
  status?: 'PROCESSING' | 'ACTIVE' | 'PAUSED';
  /** The Facebook campaign of a launch that was interrupted mid-build (rate limit) — NOT "launched". */
  fbPendingCampaignId?: string | null;
}

async function makeCampaign({ channelId = null, fbCampaignId = null, adProvider = 'FACEBOOK', whopCampaignId = null, status = 'PROCESSING', fbPendingCampaignId = null }: CampaignShape = {}): Promise<string> {
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: `AL ${Math.random()}`,
        status,
        keywords: [],
        channelId,
        fbCampaignId,
        adProvider,
        whopCampaignId,
        fbPendingCampaignId,
      },
    }),
  );
  return c.id;
}

/**
 * An OFFERS campaign (the standard model): channel lives on each PAID offer's
 * `channelRef`, NOT on `campaign.channelId`. `bothAssigned=false` leaves one PAID
 * offer without a channel (assignment not complete yet).
 */
async function makeOffersCampaign({ bothAssigned = true }: { bothAssigned?: boolean } = {}): Promise<string> {
  return withSystem(async (tx) => {
    const c = await tx.campaign.create({
      data: { orgId, buyerId, name: `ALO ${Math.random()}`, status: 'PROCESSING', keywords: [], channelId: null },
    });
    const chA = await tx.channel.create({ data: { channelId: `al-${suffix}-${Math.random().toString(36).slice(2, 8)}`, domainId: domA, status: 'ASSIGNED', currentCampaignId: c.id } });
    await tx.offer.create({ data: { orgId, campaignId: c.id, domainId: domA, weightPct: 60, kind: 'PAID', channelRef: chA.id } });
    const chB = bothAssigned
      ? await tx.channel.create({ data: { channelId: `al-${suffix}-${Math.random().toString(36).slice(2, 8)}`, domainId: domB, status: 'ASSIGNED', currentCampaignId: c.id } })
      : null;
    await tx.offer.create({ data: { orgId, campaignId: c.id, domainId: domB, weightPct: 40, kind: 'PAID', channelRef: chB?.id ?? null } });
    return c.id;
  });
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
    afsId = (await tx.googleConnection.create({ data: { accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 3_600_000), adsenseAccount: `acc-${suffix}`, adsenseAdClient: `adc-${suffix}`, afsPubId: `pub-${suffix}`, label: 'AFS', status: 'ACTIVE' } })).id;
    domA = (await tx.domain.create({ data: { host: `ala-${suffix}.example.com`, afsAccountId: afsId, status: 'LIVE', verifyToken: `a-${suffix}` } })).id;
    domB = (await tx.domain.create({ data: { host: `alb-${suffix}.example.com`, afsAccountId: afsId, status: 'LIVE', verifyToken: `b-${suffix}` } })).id;
  });
});

beforeEach(async () => {
  await setOrgAutoLaunch(true);
  await withSystem((tx) => tx.campaign.deleteMany({ where: { orgId } })); // cascades offers
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `al-${suffix}-` } } });
    await tx.domain.deleteMany({ where: { afsAccountId: afsId } });
    await tx.googleConnection.deleteMany({ where: { id: afsId } });
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

  it('launches a Whop campaign the same way (the launch routes by provider on the API side)', async () => {
    const id = await makeCampaign({ channelId: randomUUID(), adProvider: 'WHOP' });
    const enqueueLaunch = vi.fn(async () => {});
    expect((await triggerAutoLaunch(id, { enqueueLaunch })).enqueued).toBe(true);
    expect(enqueueLaunch).toHaveBeenCalledWith(id);
  });

  it('resumes a half-launched Whop campaign: its Whop draft exists, but it is not launched until it is ACTIVE', async () => {
    const id = await makeCampaign({ channelId: randomUUID(), adProvider: 'WHOP', whopCampaignId: 'adcamp_HalfBuilt1', status: 'PROCESSING' });
    const enqueueLaunch = vi.fn(async () => {});
    expect((await triggerAutoLaunch(id, { enqueueLaunch })).enqueued).toBe(true);
  });

  it('does NOT re-enqueue a Whop campaign that is live or paused at Whop', async () => {
    const enqueueLaunch = vi.fn(async () => {});
    for (const status of ['ACTIVE', 'PAUSED'] as const) {
      const id = await makeCampaign({ channelId: randomUUID(), adProvider: 'WHOP', whopCampaignId: `adcamp_Live${status}`, status });
      expect((await triggerAutoLaunch(id, { enqueueLaunch })).enqueued).toBe(false);
    }
    expect(enqueueLaunch).not.toHaveBeenCalled();
  });

  it('is idempotent — does NOT re-enqueue a campaign already on Facebook', async () => {
    const id = await makeCampaign({ channelId: randomUUID(), fbCampaignId: 'fbcamp-123' });
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(id, { enqueueLaunch });

    expect(res.enqueued).toBe(false);
    expect(enqueueLaunch).not.toHaveBeenCalled();
  });

  // A rate-limited launch records the Facebook campaign it already created in `fbPendingCampaignId` and
  // leaves `fbCampaignId` (= "fully launched") null. The gate must keep treating it as launchable — otherwise
  // auto-launch and the BATCHED re-drive could never finish the build (and the launch RESUMES it, it doesn't duplicate).
  it('still enqueues a campaign whose Facebook build is UNFINISHED (fbPendingCampaignId set, fbCampaignId null)', async () => {
    const id = await makeCampaign({ channelId: randomUUID(), fbPendingCampaignId: 'fbcamp-half-built' });
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(id, { enqueueLaunch });

    expect(res.enqueued).toBe(true);
    expect(enqueueLaunch).toHaveBeenCalledWith(id);
  });

  it('does NOT enqueue for a missing campaign', async () => {
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(randomUUID(), { enqueueLaunch });

    expect(res.enqueued).toBe(false);
    expect(enqueueLaunch).not.toHaveBeenCalled();
  });

  // Regression: an offers campaign carries its channel on each PAID offer's `channelRef`,
  // NOT on `campaign.channelId`. The trigger must recognize that or auto-launch never fires
  // and the campaign sits in PROCESSING even with both org toggles on.
  it('enqueues an OFFERS campaign once every PAID offer holds a channel (channelId is null)', async () => {
    const id = await makeOffersCampaign({ bothAssigned: true });
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(id, { enqueueLaunch });

    expect(res.enqueued).toBe(true);
    expect(enqueueLaunch).toHaveBeenCalledWith(id);
  });

  it('does NOT enqueue an offers campaign while a PAID offer still lacks a channel', async () => {
    const id = await makeOffersCampaign({ bothAssigned: false });
    const enqueueLaunch = vi.fn(async () => {});

    const res = await triggerAutoLaunch(id, { enqueueLaunch });

    expect(res.enqueued).toBe(false);
    expect(enqueueLaunch).not.toHaveBeenCalled();
  });
});

describe('FB_LAUNCH job options (D19)', () => {
  // A launch that fails for any reason OTHER than a rate limit must never be retried by BullMQ: a blind retry
  // can repeat a deterministic rejection, and worsens an ad-account security checkpoint (FB code 368). A rate
  // limit is not a job failure at all — the API parks the campaign in BATCHED and answers 200 — so `attempts: 1`
  // costs nothing there. (The resumable build makes a *manual* relaunch safe; it does not make auto-retry wise.)
  it('is de-duped per campaign and attempts:1 — BullMQ never retries a failed launch', async () => {
    const add = vi.fn(async (..._args: unknown[]) => undefined);

    await enqueueFbLaunch('camp-1', { add });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('launch', { campaignId: 'camp-1' }, expect.objectContaining({ jobId: launchJobId('camp-1'), attempts: 1 }));
  });
});

describe('launchJobId (BullMQ de-dupe key)', () => {
  it('is colon-free — BullMQ rejects a custom job id containing ":"', () => {
    // Regression: `launch:${id}` throws "Custom Id cannot contain :" on bullmq >=5.7x,
    // which silently broke the approve→assign→auto-launch chain (the channel-maintenance
    // `assign` job failed the moment it tried to enqueue the launch). Keep this colon-free.
    const id = '883851b6-1e91-4163-9d96-6b7c783685d0';
    expect(launchJobId(id)).toBe(`launch-${id}`);
    expect(launchJobId(id)).not.toContain(':');
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

  it('throws on a non-2xx response so the job fails (never auto-retried — attempts:1)', async () => {
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

describe('syncAllFbConnections', () => {
  it('POSTs the internal sync-connections endpoint with the shared token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connections: 3, synced: 3, failed: 0 }), { status: 200 }));

    await syncAllFbConnections({ fetch: fetchMock as unknown as typeof fetch, token: 'secret-token', baseUrl: 'http://api:3000' });

    expect(fetchMock).toHaveBeenCalledWith('http://api:3000/api/internal/sync-connections', {
      method: 'POST',
      headers: { 'x-internal-token': 'secret-token' },
    });
  });

  it('throws on a non-2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));

    await expect(
      syncAllFbConnections({ fetch: fetchMock as unknown as typeof fetch, token: 'secret-token', baseUrl: 'http://api:3000' }),
    ).rejects.toThrow(/internal connection sync failed \(500\)/);
  });

  it('throws when the internal token is not configured', async () => {
    const fetchMock = vi.fn();

    await expect(
      syncAllFbConnections({ fetch: fetchMock as unknown as typeof fetch, token: '', baseUrl: 'http://api:3000' }),
    ).rejects.toThrow(/INTERNAL_API_TOKEN is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('learnRcTermsNow (D28)', () => {
  it('POSTs the internal learn-rc-terms endpoint with the shared token and returns the summary', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ added: [{ term: 'career' }], eligibleCampaigns: 48 }), { status: 200 }));

    const r = await learnRcTermsNow({ fetch: fetchMock as unknown as typeof fetch, token: 'secret-token', baseUrl: 'http://api:3000' });

    expect(fetchMock).toHaveBeenCalledWith('http://api:3000/api/internal/learn-rc-terms', {
      method: 'POST',
      headers: { 'x-internal-token': 'secret-token' },
    });
    expect(r).toEqual({ added: [{ term: 'career' }], eligibleCampaigns: 48 });
  });

  it('throws on a non-2xx response and without a token', async () => {
    const fail = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(learnRcTermsNow({ fetch: fail as unknown as typeof fetch, token: 't', baseUrl: 'http://api:3000' })).rejects.toThrow(
      /internal rc-word learning failed \(500\)/,
    );
    const never = vi.fn();
    await expect(learnRcTermsNow({ fetch: never as unknown as typeof fetch, token: '', baseUrl: 'http://api:3000' })).rejects.toThrow(
      /INTERNAL_API_TOKEN is not configured/,
    );
    expect(never).not.toHaveBeenCalled();
  });
});
