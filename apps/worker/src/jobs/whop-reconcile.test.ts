import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { type WhopAd, type WhopAdsApi, WhopApiError, createWhopClient, whopAdsApi } from '@knn/whop';
import { type MockWhop, startMockWhop } from '@knn/whop/testing';
import { type WhopReconcileDeps, reconcileWhopCampaigns } from './whop-reconcile.js';

const suffix = Date.now().toString(36);
const BIZ = 'biz_RECONCILE01';
const KEY = 'whop_key_reconcile_test_77';

let mock: MockWhop;
let orgId = '';
let buyerId = '';
let connectionId = '';
const cleanup: string[] = [];

const newClient = () => createWhopClient({ apiKey: KEY, baseUrl: mock.baseUrl, limiter: false, jitter: 0, baseDelayMs: 1, maxRetries: 1, sleep: async () => undefined });
const api = () => whopAdsApi(newClient());
const released: string[] = [];
const resynced: string[] = [];
const notes = vi.fn();

/** Only OUR test business is served: the scan is global, and a foreign campaign must read as "cannot read", never as "gone". */
const deps = (over: WhopReconcileDeps = {}): WhopReconcileDeps => ({
  enabled: () => true,
  adsFor: (conn) => {
    if (conn.orgId !== orgId) throw new Error('not this test’s business');
    return api();
  },
  releaseChannel: async (id) => void released.push(id),
  resync: async (id) => void resynced.push(id),
  notify: notes,
  sleep: async () => undefined, // a failing side effect must not make a test wait
  rand: () => 0, // a fixed order of businesses
  ...over,
});

/** The real (mock-backed) API with some calls replaced: a test can break, or interleave with, exactly one thing. */
const withApi =
  (patch: (real: WhopAdsApi) => Partial<WhopAdsApi>): WhopReconcileDeps['adsFor'] =>
  (conn) => {
    if (conn.orgId !== orgId) throw new Error('not this test’s business');
    const real = api();
    return { ...real, ...patch(real) };
  };
const serverError = () => new WhopApiError('server', 'Whop is down', { status: 503 });

interface Tree {
  campaignId: string;
  whopCampaignId: string;
  whopGroupId: string;
  whopAdIds: string[];
  adIds: string[];
  setId: string;
}

/** A campaign that exists both in (the mock) Whop and in our DB, as if launched. */
async function launchedCampaign(o: { status?: 'ACTIVE' | 'PAUSED' | 'LAUNCHING' | 'META_REJECTED'; ads?: number; connection?: string | null; biz?: string | null; whopStatus?: string } = {}): Promise<Tree> {
  const a = api();
  const camp = await a.createCampaign({ account_id: BIZ, title: `Rec ${Math.random()}`, platform: 'meta', objective: 'leads', idempotencyKey: randomUUID() });
  const group = await a.createAdGroup({ ad_campaign_id: camp.id, title: 'g', budget_amount: 25, conversion_location: 'website', conversion_event: 'submit_application', optimization_goal: 'conversions', idempotencyKey: randomUUID() });
  const whopAds: WhopAd[] = [];
  for (let i = 0; i < (o.ads ?? 1); i++) {
    whopAds.push(await a.createAd({ ad_group_id: group.id, title: `Ad ${i}`, url: 'https://whop.com/', headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }], idempotencyKey: randomUUID() }));
  }
  mock.settle(BIZ, camp.id, { status: o.whopStatus ?? 'active', delivery_status: o.whopStatus ?? 'active' });
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: `Rec ${camp.id}`,
        status: o.status ?? 'ACTIVE',
        adProvider: 'WHOP',
        whopCampaignId: camp.id,
        whopBizId: o.biz === undefined ? BIZ : o.biz,
        whopConnectionId: o.connection === undefined ? connectionId : o.connection,
        keywords: [],
        adSets: {
          create: [
            {
              orgId,
              name: 'Set',
              whopAdGroupId: group.id,
              countries: ['US'],
              ads: { create: whopAds.map((w, i) => ({ orgId, name: `Ad ${i}`, headline: 'h', primaryText: 'p', redirectId: `rc-${suffix}-${randomUUID().slice(0, 8)}`, whopAdId: w.id })) },
            },
          ],
        },
      },
      include: { adSets: { include: { ads: true } } },
    }),
  );
  cleanup.push(c.id);
  return { campaignId: c.id, whopCampaignId: camp.id, whopGroupId: group.id, whopAdIds: whopAds.map((w) => w.id), adIds: c.adSets[0]!.ads.map((x) => x.id), setId: c.adSets[0]!.id };
}

/** Another Whop business (its own connection row) with one active campaign row, for the tests about the pass as a whole. */
async function otherBusiness(n: number, connId?: string): Promise<{ campaignId: string; bizId: string }> {
  const bizId = `biz_RECX${n}${suffix}`.slice(0, 24);
  const conn = await withSystem((tx) =>
    tx.whopConnection.create({ data: { ...(connId ? { id: connId } : {}), orgId, userId: buyerId, bizId, apiKeyEnc: 'enc', apiKeyLast4: '0000', apiVersionDate: '2026-09-29', status: 'ACTIVE' } }),
  );
  const c = await withSystem((tx) =>
    tx.campaign.create({ data: { orgId, buyerId, name: `RecX ${n}`, status: 'ACTIVE', adProvider: 'WHOP', whopCampaignId: `wcamp_x${n}${suffix}`, whopBizId: bizId, whopConnectionId: conn.id, keywords: [] } }),
  );
  cleanup.push(c.id);
  return { campaignId: c.id, bizId };
}

/** A channel of the pool held by a campaign: the marker that a stopped campaign still has routing to stop. */
const holdChannel = async (campaignId: string, n = 1): Promise<string> => {
  const ch = await withSystem((tx) => tx.channel.create({ data: { channelId: `rec-ch-${suffix}-${n}-${campaignId.slice(0, 6)}`, status: 'ASSIGNED', currentCampaignId: campaignId } }));
  return ch.id;
};

const row = (id: string) => withSystem((tx) => tx.campaign.findUniqueOrThrow({ where: { id }, include: { adSets: { include: { ads: true } } } }));
const whopCampaignRow = (id: string) => mock.businesses.get(BIZ)!.ads.campaigns.get(id)!;
const billingNotes = () => notes.mock.calls.filter(([n]) => n.type === 'whop_payment_failed');

beforeAll(async () => {
  mock = await startMockWhop();
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Rec Co', slug: `rec-${suffix}`, whopEnabled: true } });
    orgId = org.id;
    buyerId = (await tx.user.create({ data: { orgId, email: `rec-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    connectionId = (
      await tx.whopConnection.create({ data: { orgId, userId: buyerId, bizId: BIZ, apiKeyEnc: 'enc', apiKeyLast4: '7777', apiVersionDate: '2026-09-29', status: 'ACTIVE' } })
    ).id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `rec-ch-${suffix}` } } });
    await tx.auditLog.deleteMany({ where: { orgId } });
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await mock.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  mock.businesses.clear();
  mock.requests.length = 0;
  mock.failures.length = 0;
  mock.addBusiness({ bizId: BIZ, apiKey: KEY, title: 'Rec Biz' });
  released.length = 0;
  resynced.length = 0;
  notes.mockClear();
  // Every test starts from a clean company: the business above was just reset, so a campaign left over from an earlier test
  // would (correctly) read as "deleted in Whop" and be archived, polluting this test's assertions.
  await withSystem(async (tx) => {
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `rec-ch-${suffix}` } } });
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.whopConnection.deleteMany({ where: { orgId, id: { not: connectionId } } });
    await tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'ACTIVE', lastError: null } });
  });
});

describe('reconcileWhopCampaigns', () => {
  it('mirrors what Whop says onto the campaign, its ad groups and ads (display only), changing no status', async () => {
    const t = await launchedCampaign({ ads: 2 });
    mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'processing' });
    const res = await reconcileWhopCampaigns(deps());
    expect(res.checked).toBeGreaterThanOrEqual(1);
    const r = await row(t.campaignId);
    expect(r.status).toBe('ACTIVE');
    expect(r.whopDeliveryStatus).toBe('processing');
    expect(r.adSets[0]!.ads.map((a) => a.effectiveStatus)).toEqual(['IN_PROCESS', 'IN_PROCESS']);
    expect(r.adSets[0]!.effectiveStatus).toBe('IN_PROCESS');
    expect(notes).not.toHaveBeenCalled();

    // A second pass with nothing new writes nothing (the cron must not churn updated_at).
    const again = await reconcileWhopCampaigns(deps());
    expect(again.subSynced).toBe(0);
  });

  it('stops a campaign Meta rejected: META_REJECTED, paused at Whop too, channel released, edge config re-published, buyer told why', async () => {
    const t = await launchedCampaign();
    mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'all_ads_rejected', issues: [{ message: 'Ad rejected: misleading claim' }] });
    const res = await reconcileWhopCampaigns(deps());
    expect(res.rejected).toBeGreaterThanOrEqual(1);
    const r = await row(t.campaignId);
    expect(r.status).toBe('META_REJECTED');
    expect(r.whopIssues).toEqual([expect.objectContaining({ message: 'Ad rejected: misleading claim' })]);
    expect(r.adSets[0]!.ads[0]!.effectiveStatus).toBe('DISAPPROVED');
    expect(released).toContain(t.campaignId);
    expect(resynced).toContain(t.campaignId);
    // Our redirect no longer sends it traffic, so it must not keep spending at Whop either.
    expect(whopCampaignRow(t.whopCampaignId).status).toBe('paused');
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.meta_rejected', userId: buyerId, body: expect.stringMatching(/misleading claim.*paused in Whop/) }));
  });

  it('still stops a rejected campaign here when Whop will not pause it, and tells the buyer to pause it there', async () => {
    const t = await launchedCampaign();
    mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'all_ads_rejected' });
    await reconcileWhopCampaigns(
      deps({
        adsFor: withApi(() => ({
          pauseCampaign: async () => {
            throw serverError();
          },
        })),
      }),
    );
    expect((await row(t.campaignId)).status).toBe('META_REJECTED');
    expect(released).toContain(t.campaignId);
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.meta_rejected', body: expect.stringContaining('could not pause it in Whop') }));
  });

  it('does not ask Whop to pause a rejected campaign that is already paused there', async () => {
    const t = await launchedCampaign();
    mock.settle(BIZ, t.whopCampaignId, { status: 'paused', delivery_status: 'all_ads_rejected' });
    const pause = vi.fn();
    await reconcileWhopCampaigns(deps({ adsFor: withApi(() => ({ pauseCampaign: pause })) }));
    expect(pause).not.toHaveBeenCalled();
    expect((await row(t.campaignId)).status).toBe('META_REJECTED');
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.meta_rejected', body: expect.stringContaining('it is paused in Whop') }));
  });

  it('keeps a campaign running when only SOME of its ads are rejected: not paused at Whop, channel kept, buyer told once', async () => {
    const t = await launchedCampaign({ ads: 3 });
    whopAdRows().get(t.whopAdIds[1]!)!.delivery_status = 'rejected';
    await reconcileWhopCampaigns(deps());
    const r = await row(t.campaignId);
    expect(r.status).toBe('ACTIVE');
    // The rejected ad is shown as such; the others are not.
    expect(r.adSets[0]!.ads.map((a) => a.effectiveStatus).sort()).toEqual(['ACTIVE', 'ACTIVE', 'DISAPPROVED'].sort());
    expect(released).not.toContain(t.campaignId);
    expect(resynced).not.toContain(t.campaignId);
    expect(whopCampaignRow(t.whopCampaignId).status).toBe('active');
    const told = notes.mock.calls.map(([n]) => n).filter((n) => n.type === 'campaign.ads_rejected');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ userId: buyerId, body: expect.stringMatching(/1 of 3 ads.*keeps running/) });
    expect(notes).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.meta_rejected' }));

    // The next tick says nothing more about the same ad.
    notes.mockClear();
    await reconcileWhopCampaigns(deps());
    expect(notes).not.toHaveBeenCalled();

    // A second ad rejected later is announced on its own.
    whopAdRows().get(t.whopAdIds[2]!)!.delivery_status = 'rejected';
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('ACTIVE');
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.ads_rejected', body: expect.stringMatching(/2 of 3 ads/) }));
  });

  it('rejects the campaign once EVERY ad is rejected', async () => {
    const t = await launchedCampaign({ ads: 2 });
    for (const id of t.whopAdIds) whopAdRows().get(id)!.delivery_status = 'rejected';
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('META_REJECTED');
    expect(released).toContain(t.campaignId);
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.meta_rejected' }));
    expect(notes).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.ads_rejected' }));
  });

  describe('reviving a campaign that was stopped as rejected', () => {
    const rejectFirstOf = (t: Tree): void => {
      whopAdRows().get(t.whopAdIds[0]!)!.delivery_status = 'rejected';
    };

    it('brings it back ACTIVE with the same campaign, links and ads once Whop has ads that can deliver', async () => {
      const t = await launchedCampaign({ status: 'META_REJECTED', ads: 2 });
      rejectFirstOf(t);
      const claim = vi.fn(async () => ({ assigned: true }));
      await reconcileWhopCampaigns(deps({ claimChannels: claim }));
      const r = await row(t.campaignId);
      expect(r.status).toBe('ACTIVE');
      expect(claim).toHaveBeenCalledWith(t.campaignId);
      expect(resynced).toContain(t.campaignId);
      // Nothing was rebuilt: the same ads (and so the same redirect links) are still on the campaign, and Whop was not touched.
      expect(r.adSets[0]!.ads.map((a) => a.id).sort()).toEqual([...t.adIds].sort());
      expect(whopCampaignRow(t.whopCampaignId).status).toBe('active');
      expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.status_synced', title: 'Campaign is back on', userId: buyerId, body: expect.stringContaining('running again') }));

      // The next tick leaves it alone.
      notes.mockClear();
      claim.mockClear();
      await reconcileWhopCampaigns(deps({ claimChannels: claim }));
      expect(claim).not.toHaveBeenCalled();
      expect(notes).not.toHaveBeenCalled();
    });

    it('comes back PAUSED when Whop has it paused (the old rule paused it there), and says so', async () => {
      const t = await launchedCampaign({ status: 'META_REJECTED', ads: 2, whopStatus: 'paused' });
      rejectFirstOf(t);
      await reconcileWhopCampaigns(deps({ claimChannels: async () => ({ assigned: true }) }));
      expect((await row(t.campaignId)).status).toBe('PAUSED');
      expect(resynced).toContain(t.campaignId);
      expect(notes).toHaveBeenCalledWith(expect.objectContaining({ title: 'Campaign is back on', body: expect.stringContaining('resume it') }));
    });

    it('does nothing while every ad is still rejected: no channel taken, no second notice', async () => {
      const t = await launchedCampaign({ status: 'META_REJECTED', ads: 2 });
      for (const id of t.whopAdIds) whopAdRows().get(id)!.delivery_status = 'rejected';
      const claim = vi.fn(async () => ({ assigned: true }));
      await reconcileWhopCampaigns(deps({ claimChannels: claim }));
      await reconcileWhopCampaigns(deps({ claimChannels: claim }));
      expect((await row(t.campaignId)).status).toBe('META_REJECTED');
      expect(claim).not.toHaveBeenCalled();
      expect(resynced).not.toContain(t.campaignId);
      expect(released).not.toContain(t.campaignId);
      expect(notes).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.meta_rejected' }));
      expect(notes).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Campaign is back on' }));
    });

    it('waits when no channel is free (changing nothing, saying nothing) and comes back on the tick that finds one', async () => {
      const t = await launchedCampaign({ status: 'META_REJECTED', ads: 2 });
      rejectFirstOf(t);
      await reconcileWhopCampaigns(deps({ claimChannels: async () => ({ assigned: false }) }));
      expect((await row(t.campaignId)).status).toBe('META_REJECTED');
      expect(resynced).not.toContain(t.campaignId);
      expect(notes).not.toHaveBeenCalled();
      await reconcileWhopCampaigns(deps({ claimChannels: async () => ({ assigned: true }) }));
      expect((await row(t.campaignId)).status).toBe('ACTIVE');
    });

    it('survives a failing channel lookup', async () => {
      const t = await launchedCampaign({ status: 'META_REJECTED', ads: 2 });
      rejectFirstOf(t);
      await reconcileWhopCampaigns(deps({ claimChannels: async () => { throw new Error('db blip'); } }));
      expect((await row(t.campaignId)).status).toBe('META_REJECTED');
    });

    it('gives everything back when the edge will not follow: rejected again, channel released, nothing announced', async () => {
      const t = await launchedCampaign({ status: 'META_REJECTED', ads: 2 });
      rejectFirstOf(t);
      await reconcileWhopCampaigns(
        deps({
          claimChannels: async () => ({ assigned: true }),
          resync: async () => {
            throw new Error('edge down');
          },
        }),
      );
      expect((await row(t.campaignId)).status).toBe('META_REJECTED');
      expect(released).toContain(t.campaignId);
      expect(notes).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Campaign is back on' }));
    });
  });

  it('mirrors a pause and a resume done in Whop, keeping the channel', async () => {
    const t = await launchedCampaign();
    mock.settle(BIZ, t.whopCampaignId, { status: 'paused', delivery_status: 'paused' });
    const paused = await reconcileWhopCampaigns(deps());
    expect(paused.statusSynced).toBeGreaterThanOrEqual(1);
    expect((await row(t.campaignId)).status).toBe('PAUSED');
    expect(released).not.toContain(t.campaignId); // pausing is reversible: the channel stays
    expect(resynced).toContain(t.campaignId);
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.status_synced', title: 'Campaign paused' }));

    mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'active' });
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('ACTIVE');
  });

  it('archives a campaign deleted in Whop only on the SECOND consecutive miss: the first leaves a marker and changes nothing else', async () => {
    const t = await launchedCampaign();
    await api().deleteCampaign(t.whopCampaignId);

    await reconcileWhopCampaigns(deps());
    const first = await row(t.campaignId);
    expect(first.status).toBe('ACTIVE');
    expect(first.whopDeliveryStatus).toBe('not_found');
    expect(released).not.toContain(t.campaignId);
    expect(notes).not.toHaveBeenCalled();

    const second = await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('ARCHIVED');
    expect(second.statusSynced).toBeGreaterThanOrEqual(1);
    expect(released).toContain(t.campaignId);
    expect(resynced).toContain(t.campaignId);
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.status_synced', title: 'Campaign archived' }));
  });

  it('forgets a first miss as soon as Whop answers for the campaign again', async () => {
    const t = await launchedCampaign();
    await withSystem((tx) => tx.campaign.update({ where: { id: t.campaignId }, data: { whopDeliveryStatus: 'not_found' } }));
    await reconcileWhopCampaigns(deps());
    const r = await row(t.campaignId);
    expect(r.status).toBe('ACTIVE');
    expect(r.whopDeliveryStatus).toBe('active'); // the marker is gone: a later miss is a first miss again
  });

  it('never archives on absence alone: a campaign missing from the list is confirmed with a direct read first', async () => {
    const t = await launchedCampaign();
    const listOnly = deps({ adsFor: withApi(() => ({ listCampaigns: async () => [] })) }); // the list came back without it (paging, filtering)
    await reconcileWhopCampaigns(listOnly);
    await reconcileWhopCampaigns(listOnly);
    expect((await row(t.campaignId)).status).toBe('ACTIVE'); // the direct read found it, twice: nothing to do
    expect(released).not.toContain(t.campaignId);
  });

  it('skips, changing nothing, when it cannot read Whop: an outage, no connection, a broken connection', async () => {
    const outage = await launchedCampaign();
    mock.failures.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    const res = await reconcileWhopCampaigns(deps());
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect((await row(outage.campaignId)).status).toBe('ACTIVE');
    expect((await row(outage.campaignId)).whopDeliveryStatus).toBeNull(); // no "first miss" recorded on an outage
    mock.failures.length = 0;

    const orphan = await launchedCampaign({ connection: null, biz: 'biz_NOBODYHOME1' });
    await reconcileWhopCampaigns(deps());
    expect((await row(orphan.campaignId)).status).toBe('ACTIVE');
    expect((await row(orphan.campaignId)).whopDeliveryStatus).toBeNull();

    await withSystem((tx) => tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'BROKEN' } }));
    const gone = await launchedCampaign();
    await api().deleteCampaign(gone.whopCampaignId);
    await reconcileWhopCampaigns(deps());
    await reconcileWhopCampaigns(deps());
    expect((await row(gone.campaignId)).status).toBe('ACTIVE'); // "cannot read" is never "gone"
    expect((await row(gone.campaignId)).whopDeliveryStatus).toBeNull(); // and never counts towards the two-miss rule
    expect(released).not.toContain(gone.campaignId);
    expect(released).not.toContain(outage.campaignId);
    expect(released).not.toContain(orphan.campaignId);
  });

  it('flips the connection to BROKEN and tells its owner when Whop rejects the key', async () => {
    const t = await launchedCampaign();
    mock.failures.push({ status: 401 });
    await reconcileWhopCampaigns(deps());
    const conn = await withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id: connectionId } }));
    expect(conn.status).toBe('BROKEN');
    expect((await row(t.campaignId)).status).toBe('ACTIVE');
  });

  it('breaks the connection too when Whop says the key may not read the ads (403), and changes no campaign', async () => {
    const t = await launchedCampaign();
    mock.failures.push({ status: 403 });
    await reconcileWhopCampaigns(deps());
    const conn = await withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id: connectionId } }));
    expect(conn.status).toBe('BROKEN');
    expect(conn.lastError).toMatch(/permission/i);
    expect((await row(t.campaignId)).status).toBe('ACTIVE');
  });

  it('finds the business by its id when the stored connection row is gone (disconnect, then reconnect)', async () => {
    const t = await launchedCampaign({ connection: '00000000-0000-4000-8000-000000000000' });
    mock.settle(BIZ, t.whopCampaignId, { status: 'paused', delivery_status: 'paused' });
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('PAUSED');
  });

  it('tells the buyer once when Whop cannot charge their payment method, and changes no status', async () => {
    const t = await launchedCampaign();
    mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'payment_failed' });
    await reconcileWhopCampaigns(deps());
    expect(billingNotes()).toHaveLength(1);
    expect((await row(t.campaignId)).status).toBe('ACTIVE');
    await reconcileWhopCampaigns(deps());
    expect(billingNotes()).toHaveLength(1); // not again on the next tick
  });

  it('tells it once per failure when Whop reports the billing problem through the status word, and again if it recurs after being fixed', async () => {
    const t = await launchedCampaign();
    mock.settle(BIZ, t.whopCampaignId, { status: 'payment_failed', delivery_status: 'active' });
    await reconcileWhopCampaigns(deps());
    await reconcileWhopCampaigns(deps());
    expect(billingNotes()).toHaveLength(1);
    const r = await row(t.campaignId);
    expect(r.whopDeliveryStatus).toBe('payment_failed'); // what stops the repeat
    expect(r.status).toBe('ACTIVE'); // a billing failure is not a state change

    mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'active' });
    await reconcileWhopCampaigns(deps());
    mock.settle(BIZ, t.whopCampaignId, { status: 'payment_failed', delivery_status: 'active' });
    await reconcileWhopCampaigns(deps());
    expect(billingNotes()).toHaveLength(2);
  });

  it('does not churn when Whop lists the same issues in another order (they are compared as a set)', async () => {
    const t = await launchedCampaign();
    mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'issues', issues: [{ message: 'first problem' }, { message: 'second problem' }] });
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).whopIssues as unknown[]).toHaveLength(2);
    whopCampaignRow(t.whopCampaignId).issues.reverse();
    const again = await reconcileWhopCampaigns(deps());
    expect(again.subSynced).toBe(0);
  });

  it('does nothing at all while Whop Ads is off, and never touches a Facebook campaign', async () => {
    const t = await launchedCampaign();
    mock.settle(BIZ, t.whopCampaignId, { status: 'paused', delivery_status: 'paused' });
    const off = await reconcileWhopCampaigns(deps({ enabled: () => false }));
    expect(off).toMatchObject({ checked: 0, rejected: 0, statusSynced: 0, recovered: 0 });
    expect((await row(t.campaignId)).status).toBe('ACTIVE');

    const fb = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'fb', status: 'ACTIVE', keywords: [], fbCampaignId: 'fb-1' } }));
    cleanup.push(fb.id);
    await reconcileWhopCampaigns(deps());
    expect((await row(fb.id)).status).toBe('ACTIVE');
  });

  describe('writes are conditional on what this tick read (nothing is lost to a change made meanwhile)', () => {
    it('a status the buyer changed here while the tick was reading Whop is not flipped back', async () => {
      const t = await launchedCampaign();
      mock.settle(BIZ, t.whopCampaignId, { status: 'paused', delivery_status: 'paused' });
      const res = await reconcileWhopCampaigns(
        deps({
          adsFor: withApi((real) => ({
            listCampaigns: async (p) => {
              // Between the tick's read of our rows and its write, the campaign is archived here.
              await withSystem((tx) => tx.campaign.update({ where: { id: t.campaignId }, data: { status: 'ARCHIVED' } }));
              return real.listCampaigns(p);
            },
          })),
        }),
      );
      expect((await row(t.campaignId)).status).toBe('ARCHIVED'); // not turned into PAUSED by a stale read
      expect(res.statusSynced).toBe(0);
      expect(notes).not.toHaveBeenCalled();
    });

    it('a rejection applied to a row that moved meanwhile waits for the next tick, which then applies it', async () => {
      const t = await launchedCampaign();
      mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'all_ads_rejected' });
      await reconcileWhopCampaigns(
        deps({
          adsFor: withApi((real) => ({
            listCampaigns: async (p) => {
              await withSystem((tx) => tx.campaign.update({ where: { id: t.campaignId }, data: { status: 'PAUSED' } })); // the buyer paused it here
              return real.listCampaigns(p);
            },
          })),
        }),
      );
      expect((await row(t.campaignId)).status).toBe('PAUSED');
      expect(released).not.toContain(t.campaignId);
      expect(notes).not.toHaveBeenCalled();

      await reconcileWhopCampaigns(deps());
      expect((await row(t.campaignId)).status).toBe('META_REJECTED'); // the next tick sees the new state and acts on it
      expect(released).toContain(t.campaignId);
    });

    it('a relaunch that swapped the Whop campaign meanwhile is not overwritten with the old campaign\'s words', async () => {
      const t = await launchedCampaign();
      mock.settle(BIZ, t.whopCampaignId, { status: 'paused', delivery_status: 'all_ads_rejected', issues: [{ message: 'stale rejection' }] });
      await reconcileWhopCampaigns(
        deps({
          adsFor: withApi((real) => ({
            listCampaigns: async (p) => {
              await withSystem((tx) => tx.campaign.update({ where: { id: t.campaignId }, data: { whopCampaignId: `wcamp_new_${suffix}`, whopDeliveryStatus: 'draft' } }));
              return real.listCampaigns(p);
            },
          })),
        }),
      );
      const r = await row(t.campaignId);
      expect(r.status).toBe('ACTIVE');
      expect(r.whopDeliveryStatus).toBe('draft'); // the old campaign's delivery word was not written onto the new one
      expect(r.whopIssues).toEqual([]); // the old campaign's rejection was not written onto the new one
      expect(notes).not.toHaveBeenCalled();
      expect(released).not.toContain(t.campaignId);
    });
  });

  describe('one business, one campaign, one failure at a time', () => {
    it('reads a campaign\'s ads on their own when Whop refuses the batch, so one campaign cannot hide the others', async () => {
      const a = await launchedCampaign();
      const b = await launchedCampaign();
      for (const t of [a, b]) mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'processing' });
      await reconcileWhopCampaigns(
        deps({
          adsFor: withApi((real) => ({
            listAds: async (p) => {
              if (p.campaignIds.length > 1) throw new WhopApiError('validation', 'one of those ids is not valid', { status: 400 });
              return real.listAds(p);
            },
          })),
        }),
      );
      expect((await row(a.campaignId)).whopDeliveryStatus).toBe('processing');
      expect((await row(b.campaignId)).whopDeliveryStatus).toBe('processing');
    });

    it('decides nothing about a campaign whose ads it could not read, even when Whop says something drastic about the campaign', async () => {
      const t = await launchedCampaign();
      mock.settle(BIZ, t.whopCampaignId, { status: 'paused', delivery_status: 'paused' });
      const res = await reconcileWhopCampaigns(
        deps({
          adsFor: withApi(() => ({
            listAds: async () => {
              throw new WhopApiError('validation', 'no', { status: 400 });
            },
          })),
        }),
      );
      expect(res.skipped).toBeGreaterThanOrEqual(1);
      expect((await row(t.campaignId)).status).toBe('ACTIVE');
      expect(notes).not.toHaveBeenCalled();
    });

    it('carries on with the next campaign when one blows up for a reason of its own', async () => {
      const a = await launchedCampaign();
      const b = await launchedCampaign();
      for (const t of [a, b]) mock.settle(BIZ, t.whopCampaignId, { status: 'paused', delivery_status: 'paused' });
      let blewUp = false;
      const res = await reconcileWhopCampaigns(
        deps({
          // The first announcement this pass tries to send throws; the pass must still reach the other campaign.
          notify: (n) => {
            if (!blewUp) {
              blewUp = true;
              throw new Error('webhook exploded');
            }
            notes(n);
          },
        }),
      );
      expect(res.skipped).toBeGreaterThanOrEqual(1);
      expect((await row(a.campaignId)).status).toBe('PAUSED');
      expect((await row(b.campaignId)).status).toBe('PAUSED');
      expect(notes).toHaveBeenCalledTimes(1); // the other campaign's announcement still went out
    });

    it('tells the buyer the truth when the channel could not be released: the edge is updated first, and the release is retried next pass', async () => {
      const t = await launchedCampaign();
      mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'all_ads_rejected' });
      await holdChannel(t.campaignId);
      let attempts = 0;
      await reconcileWhopCampaigns(
        deps({
          releaseChannel: async () => {
            attempts += 1;
            throw new Error('db down');
          },
        }),
      );
      expect((await row(t.campaignId)).status).toBe('META_REJECTED');
      expect(attempts).toBe(3); // tried three times
      expect(resynced).toContain(t.campaignId); // the edge was updated first
      const told = notes.mock.calls.map(([n]) => n).find((n) => n.type === 'campaign.meta_rejected')!;
      expect(told.body).toContain('retried automatically');
      expect(told.body).not.toContain('channel released');

      // The next pass finds the stopped campaign still holding its channel and finishes the job.
      notes.mockClear();
      const next = await reconcileWhopCampaigns(deps());
      expect(next.repaired).toBeGreaterThanOrEqual(1);
      expect(released).toContain(t.campaignId);
    });

    it('never releases a channel before the edge stops emitting it: if the edge update fails, the channel stays held and both are retried', async () => {
      const t = await launchedCampaign();
      mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'all_ads_rejected' });
      await holdChannel(t.campaignId);
      let resyncAttempts = 0;
      await reconcileWhopCampaigns(
        deps({
          resync: async () => {
            resyncAttempts += 1;
            throw new Error('api is deploying');
          },
        }),
      );
      expect((await row(t.campaignId)).status).toBe('META_REJECTED'); // it IS stopped
      expect(resyncAttempts).toBeGreaterThanOrEqual(3);
      expect(released).not.toContain(t.campaignId); // ...but its channel is not handed to anyone while the edge may still emit it
      expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.meta_rejected', body: expect.stringContaining('retried automatically') }));

      // Once the API is back, the repair pass does both, in that order.
      const order: string[] = [];
      const repaired = await reconcileWhopCampaigns(
        deps({
          resync: async (id) => void (id === t.campaignId && order.push('resync')),
          releaseChannel: async (id) => void (id === t.campaignId && order.push('release')),
        }),
      );
      expect(repaired.repaired).toBeGreaterThanOrEqual(1);
      expect(order).toEqual(['resync', 'release']);
    });

    it('archiving a campaign deleted in Whop stops its routing the same way, and says so honestly', async () => {
      const t = await launchedCampaign();
      await api().deleteCampaign(t.whopCampaignId);
      await reconcileWhopCampaigns(deps()); // first miss: the marker
      await holdChannel(t.campaignId);
      await reconcileWhopCampaigns(deps({ resync: async () => { throw new Error('api is deploying'); } })); // second miss: archived, edge not updated
      expect((await row(t.campaignId)).status).toBe('ARCHIVED');
      expect(released).not.toContain(t.campaignId);
      expect(notes).toHaveBeenCalledWith(expect.objectContaining({ title: 'Campaign archived', body: expect.stringContaining('retried automatically') }));
      await reconcileWhopCampaigns(deps());
      expect(released).toContain(t.campaignId);
    });

    it('repairs only what is stopped: a live campaign, a paused one and a Facebook campaign keep the channel they hold', async () => {
      const live = await launchedCampaign();
      const paused = await launchedCampaign({ status: 'PAUSED', whopStatus: 'paused' });
      const fb = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'fb held', status: 'META_REJECTED', adProvider: 'FACEBOOK', keywords: [] } }));
      cleanup.push(fb.id);
      const stopped = await launchedCampaign();
      await withSystem((tx) => tx.campaign.update({ where: { id: stopped.campaignId }, data: { status: 'META_REJECTED' } }));
      for (const [i, id] of [live.campaignId, paused.campaignId, fb.id, stopped.campaignId].entries()) await holdChannel(id, i);
      await reconcileWhopCampaigns(deps());
      expect(released).toContain(stopped.campaignId);
      for (const id of [live.campaignId, paused.campaignId, fb.id]) expect(released).not.toContain(id);
    });

    it('does not announce a resume the edge did not follow: the status is given back, and the next tick does it all again', async () => {
      const t = await launchedCampaign({ status: 'PAUSED', whopStatus: 'paused' });
      mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'active' }); // resumed in Whop
      await reconcileWhopCampaigns(deps({ resync: async () => { throw new Error('api is deploying'); } }));
      expect((await row(t.campaignId)).status).toBe('PAUSED'); // still what the edge says: the two agree, nothing was lost
      expect(notes).not.toHaveBeenCalled();

      await reconcileWhopCampaigns(deps());
      expect((await row(t.campaignId)).status).toBe('ACTIVE');
      expect(resynced).toContain(t.campaignId);
      expect(notes).toHaveBeenCalledWith(expect.objectContaining({ title: 'Campaign resumed' }));
    });

    it('gives up for this pass after three businesses in a row fail to answer, instead of waiting on a dead Whop', async () => {
      for (const n of [1, 2, 3, 4]) await otherBusiness(n);
      let asked = 0;
      const res = await reconcileWhopCampaigns(
        deps({
          adsFor: (conn) => {
            if (conn.orgId !== orgId) throw new Error('foreign');
            asked += 1;
            return { ...api(), listCampaigns: async () => { throw serverError(); } } as WhopAdsApi;
          },
        }),
      );
      expect(asked).toBe(3); // the fourth business was never tried
      expect(res.skipped).toBeGreaterThanOrEqual(4);
      expect(await withSystem((tx) => tx.whopConnection.count({ where: { orgId, status: 'BROKEN' } }))).toBe(0); // an outage is nobody's fault
    });

    it('counts only businesses that failed to ANSWER towards "Whop is down": a rate limit is Whop answering, so the fourth is still read', async () => {
      const ids = [1, 2, 3, 4].map((n) => `0000000${n}-0000-4000-8000-000000000000`);
      for (const [i, id] of ids.entries()) await otherBusiness(i + 1, id);
      let asked = 0;
      await reconcileWhopCampaigns(
        deps({
          adsFor: (conn) => {
            if (conn.orgId !== orgId) throw new Error('foreign');
            asked += 1;
            return { ...api(), listCampaigns: async () => { throw new WhopApiError('rate_limited', 'slow down', { status: 429 }); } } as WhopAdsApi;
          },
        }),
      );
      expect(asked).toBe(4);
    });

    it('a run of failures is CONSECUTIVE: outage, outage, rejected key, outage does not stop the pass', async () => {
      const ids = [1, 2, 3, 4].map((n) => `0000000${n}-0000-4000-8000-000000000000`);
      for (const [i, id] of ids.entries()) await otherBusiness(i + 1, id);
      const behaviors = [503, 503, 401, 503] as const;
      let call = 0;
      await reconcileWhopCampaigns(
        deps({
          adsFor: (conn) => {
            if (conn.orgId !== orgId) throw new Error('foreign');
            const status = behaviors[call++]!;
            const err = status === 401 ? new WhopApiError('auth', 'bad key', { status }) : new WhopApiError('server', 'Whop is down', { status });
            return { ...api(), listCampaigns: async () => { throw err; } } as WhopAdsApi;
          },
        }),
      );
      expect(call).toBe(4);
    });

    it('gives every business its turn: a pass that stops early does not leave the same ones unread every time', async () => {
      const ids = [1, 2, 3, 4].map((n) => `0000000${n}-0000-4000-8000-000000000000`);
      await otherBusiness(1, ids[0]);
      await otherBusiness(2, ids[1]);
      await otherBusiness(3, ids[2]);
      const healthy = await otherBusiness(4, ids[3]);
      const run = async (rand: number): Promise<boolean> => {
        let healthyRead = false;
        await reconcileWhopCampaigns(
          deps({
            rand: () => rand,
            adsFor: (conn) => {
              if (conn.orgId !== orgId) throw new Error('foreign');
              if (conn.bizId === healthy.bizId) {
                healthyRead = true;
                return { ...api(), listCampaigns: async () => [] } as WhopAdsApi;
              }
              return { ...api(), listCampaigns: async () => { throw serverError(); } } as WhopAdsApi;
            },
          }),
        );
        return healthyRead;
      };
      expect(await run(0)).toBe(false); // fixed order: three failing first, the pass stops
      const reads: boolean[] = [];
      for (let k = 0; k < 20; k++) reads.push(await run(k / 20));
      expect(reads.some(Boolean)).toBe(true);
      expect(reads.some((r) => !r)).toBe(true);
    });

    it('stops starting new businesses once its time budget is spent', async () => {
      await otherBusiness(1);
      await otherBusiness(2);
      let clock = 0;
      let asked = 0;
      const res = await reconcileWhopCampaigns(
        deps({
          budgetMs: 60_000,
          clock: () => clock,
          adsFor: (conn) => {
            if (conn.orgId !== orgId) throw new Error('foreign');
            asked += 1;
            clock += 10 * 60_000; // reading the first business took "ten minutes"
            return { ...api(), listCampaigns: async () => { throw new WhopApiError('validation', 'refused', { status: 400 }); } } as WhopAdsApi;
          },
        }),
      );
      expect(asked).toBe(1);
      expect(res.skipped).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('a launch that died mid-way', () => {
  const backdate = (id: string, minutes: number) =>
    withSystem((tx) => tx.$executeRaw`UPDATE campaigns SET updated_at = now() - (${minutes} * interval '1 minute') WHERE id = ${id}::uuid`);
  /** The whole tree has been quiet for `minutes` (a live launch keeps touching some part of it). */
  const backdateTree = async (campaignId: string, minutes: number): Promise<void> => {
    await backdate(campaignId, minutes);
    await withSystem(async (tx) => {
      await tx.$executeRaw`UPDATE ad_sets SET updated_at = now() - (${minutes} * interval '1 minute') WHERE campaign_id = ${campaignId}::uuid`;
      await tx.$executeRaw`UPDATE ads SET updated_at = now() - (${minutes} * interval '1 minute') WHERE ad_set_id IN (SELECT id FROM ad_sets WHERE campaign_id = ${campaignId}::uuid)`;
    });
  };
  const launching = async (): Promise<string> => {
    const c = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'stuck', status: 'LAUNCHING', adProvider: 'WHOP', keywords: [] } }));
    cleanup.push(c.id);
    return c.id;
  };
  /** A campaign that went LAUNCHING, got as far as creating its Whop campaign, and then went quiet. */
  const stuckOnWhop = async (whopStatus?: string): Promise<Tree> => {
    const t = await launchedCampaign({ status: 'LAUNCHING', whopStatus });
    await backdateTree(t.campaignId, 20);
    return t;
  };

  it('goes back to PROCESSING when Whop was never reached, so it can be launched again, and the buyer is told', async () => {
    const stuck = await launching();
    await backdate(stuck, 20);
    const res = await reconcileWhopCampaigns(deps());
    expect(res.recovered).toBeGreaterThanOrEqual(1);
    expect((await row(stuck)).status).toBe('PROCESSING');
    expect(resynced).toContain(stuck); // its edge config was written ACTIVE for Whop's pixel check
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'whop_launch_failed', userId: buyerId }));
  });

  it('leaves a launch that is still alive alone', async () => {
    const alive = await launching();
    await backdate(alive, 2);
    await reconcileWhopCampaigns(deps());
    expect((await row(alive)).status).toBe('LAUNCHING');
  });

  it('counts a launch as alive while any part of its tree is still being written, even when the campaign row is quiet', async () => {
    const t = await stuckOnWhop();
    await withSystem((tx) => tx.ad.update({ where: { id: t.adIds[0]! }, data: { effectiveStatus: 'IN_PROCESS' } }));
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('LAUNCHING');
    expect(notes).not.toHaveBeenCalled();
  });

  it('counts a launch as alive while an ad SET is still being written, even when the campaign row and its ads are quiet', async () => {
    const t = await stuckOnWhop();
    await withSystem((tx) => tx.adSet.update({ where: { id: t.setId }, data: { name: 'Set (renamed)' } }));
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('LAUNCHING');
    expect(notes).not.toHaveBeenCalled();
  });

  it('completes a launch Whop shows live (its result was never saved): ACTIVE, Whop\'s word kept, audited, the buyer told it is live', async () => {
    const t = await stuckOnWhop();
    mock.settle(BIZ, t.whopCampaignId, { status: 'active', delivery_status: 'processing' });
    const res = await reconcileWhopCampaigns(deps());
    expect(res.recovered).toBeGreaterThanOrEqual(1);
    const r = await row(t.campaignId);
    expect(r.status).toBe('ACTIVE');
    expect(r.whopDeliveryStatus).toBe('processing');
    expect(resynced).toContain(t.campaignId); // the edge config now follows the ACTIVE status
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.live', userId: buyerId }));
    const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { entityId: t.campaignId, action: 'campaign.launched' } }));
    expect(audit?.details).toMatchObject({ provider: 'WHOP', whopCampaignId: t.whopCampaignId, completedBy: 'status-sync' });
    // Completing it again is not a thing: a second pass finds nothing stuck.
    notes.mockClear();
    await reconcileWhopCampaigns(deps());
    expect(notes.mock.calls.filter(([n]) => n.type === 'campaign.live')).toHaveLength(0);
  });

  it('completes it as PAUSED when Whop shows it paused meanwhile', async () => {
    const t = await stuckOnWhop('paused');
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('PAUSED');
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.status_synced', title: 'Campaign launched, then paused' }));
  });

  it('gives a campaign Whop never activated (still a draft) back to PROCESSING, keeping its Whop ids so a relaunch continues from them', async () => {
    const t = await stuckOnWhop('draft');
    await reconcileWhopCampaigns(deps());
    const r = await row(t.campaignId);
    expect(r.status).toBe('PROCESSING');
    expect(r.whopCampaignId).toBe(t.whopCampaignId);
    expect(notes).toHaveBeenCalledWith(expect.objectContaining({ type: 'whop_launch_failed' }));
  });

  it('waits one more tick before giving back a launch whose Whop campaign cannot be found (two misses, never one)', async () => {
    const t = await stuckOnWhop();
    await api().deleteCampaign(t.whopCampaignId);
    await reconcileWhopCampaigns(deps());
    const first = await row(t.campaignId);
    expect(first.status).toBe('LAUNCHING');
    expect(first.whopDeliveryStatus).toBe('not_found');
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('PROCESSING');
  });

  it('never guesses when it cannot read Whop: an outage or a broken connection leaves the launch as it is (Whop may be spending)', async () => {
    const t = await stuckOnWhop();
    mock.failures.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('LAUNCHING');
    mock.failures.length = 0;

    await withSystem((tx) => tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'BROKEN' } }));
    await reconcileWhopCampaigns(deps());
    expect((await row(t.campaignId)).status).toBe('LAUNCHING');
    expect(notes).not.toHaveBeenCalled();
  });
});

const whopAdRows = () => mock.businesses.get(BIZ)!.ads.ads;
