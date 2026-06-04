import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CampaignDeliveryDTO } from '@knn/fb';
import { prisma, withSystem } from '@knn/db';
import { type CampaignStatus, ROLES, USER_STATUS } from '@knn/shared';
import { reconcileCampaigns } from './meta-rejection.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';

async function makeCampaign(fbCampaignId: string | null, status: CampaignStatus = 'ACTIVE'): Promise<string> {
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: { orgId, buyerId, name: `MR ${Math.random()}`, status, keywords: [], fbCampaignId },
    }),
  );
  return c.id;
}

async function makeAdSetWithAd(
  campaignId: string,
  fbAdSetId: string | null,
  fbAdId: string | null,
): Promise<{ adSetId: string; adId: string }> {
  return withSystem(async (tx) => {
    const set = await tx.adSet.create({ data: { orgId, campaignId, name: 'set', fbAdSetId } });
    const ad = await tx.ad.create({
      data: {
        orgId,
        adSetId: set.id,
        name: 'ad',
        headline: 'H',
        primaryText: 'P',
        redirectId: `r-${suffix}-${Math.random().toString(36).slice(2)}`,
        fbAdId,
      },
    });
    return { adSetId: set.id, adId: ad.id };
  });
}

async function statusOf(id: string): Promise<string | undefined> {
  const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id }, select: { status: true } }));
  return c?.status;
}

// reconcileCampaigns scans EVERY launched campaign globally (cross-org). The api package's tests run
// concurrently against the SAME Postgres, so their ACTIVE/PAUSED campaigns get swept into the scan
// here too. Scope each fixture's delivery to its OWN campaign: any other campaign returns an empty
// no-op delivery (effectiveStatus '' → null target → left alone; no ads → never rejected; no
// sub-entities), so a foreign suite's rows can't inflate the result counters or be mutated. We then
// assert our own campaign's observable outcome, never a global aggregate (worker CLAUDE.md).
const NOOP_DELIVERY: CampaignDeliveryDTO = { effectiveStatus: '', accountId: '', adSets: [], ads: [] };
const onlyFor =
  (id: string, delivery: CampaignDeliveryDTO) =>
  async (c: { id: string }): Promise<CampaignDeliveryDTO> =>
    c.id === id ? delivery : NOOP_DELIVERY;

async function subStatusOf(ids: { adSetId: string; adId: string }): Promise<{ set: string | null; ad: string | null }> {
  return withSystem(async (tx) => {
    const set = await tx.adSet.findUnique({ where: { id: ids.adSetId }, select: { effectiveStatus: true } });
    const ad = await tx.ad.findUnique({ where: { id: ids.adId }, select: { effectiveStatus: true } });
    return { set: set?.effectiveStatus ?? null, ad: ad?.effectiveStatus ?? null };
  });
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'MR Co', slug: `mr-${suffix}` } });
    orgId = org.id;
    const buyer = await tx.user.create({ data: { orgId, email: `mr-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } });
    buyerId = buyer.id;
  });
});

beforeEach(async () => {
  await withSystem((tx) => tx.campaign.deleteMany({ where: { orgId } }));
});

afterAll(async () => {
  await withSystem((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  await prisma.$disconnect();
});

describe('reconcileCampaigns', () => {
  // ── Meta-rejection (D14) ───────────────────────────────────────────────────────
  it('flags a campaign with a DISAPPROVED ad → META_REJECTED + releases channel + notifies', async () => {
    const id = await makeCampaign('fbcamp-1');
    const releaseChannel = vi.fn(async () => ({ released: true }));
    const resync = vi.fn(async () => undefined);
    const notify = vi.fn();

    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, {
        effectiveStatus: 'ACTIVE',
        accountId: 'act_test', adSets: [],
        ads: [{ fbAdId: 'a1', effectiveStatus: 'ACTIVE' }, { fbAdId: 'a2', effectiveStatus: 'DISAPPROVED' }],
      }),
      releaseChannel,
      resync,
      notify,
    });

    expect(res.rejected).toBe(1);
    expect(res.statusSynced).toBe(0);
    expect(releaseChannel).toHaveBeenCalledWith(id);
    // B1: the rejected campaign's edge KV is re-published (active:false, channel dropped) so residual
    // paid clicks stop monetizing a disapproved page and stop crediting the channel's next holder.
    expect(resync).toHaveBeenCalledWith(id);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]?.type).toBe('campaign.meta_rejected');
    expect(await statusOf(id)).toBe('META_REJECTED');
  });

  it('leaves an all-ACTIVE campaign untouched when FB also reports ACTIVE', async () => {
    const id = await makeCampaign('fbcamp-2');
    const releaseChannel = vi.fn(async () => ({ released: false }));
    const resync = vi.fn(async () => undefined);
    const notify = vi.fn();

    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, { effectiveStatus: 'ACTIVE', accountId: 'act_test', adSets: [], ads: [{ fbAdId: 'a1', effectiveStatus: 'ACTIVE' }] }),
      releaseChannel,
      resync,
      notify,
    });

    expect(res.rejected).toBe(0);
    expect(res.statusSynced).toBe(0);
    expect(res.subSynced).toBe(0);
    expect(releaseChannel).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('skips campaigns whose delivery fetch throws (keeps going)', async () => {
    const id = await makeCampaign('fbcamp-3');
    let scanned = false;
    const res = await reconcileCampaigns({
      // Throw for THIS campaign (foreign concurrent campaigns no-op) → prove the loop survives the error.
      fetchDelivery: async (c) => {
        if (c.id === id) {
          scanned = true;
          throw new Error('FB down');
        }
        return NOOP_DELIVERY;
      },
      releaseChannel: vi.fn(async () => ({ released: false })),
      resync: vi.fn(async () => undefined),
      notify: vi.fn(),
    });
    expect(scanned).toBe(true); // our campaign was reached (its fetch threw and was caught)
    expect(res.rejected).toBe(0);
    expect(res.statusSynced).toBe(0);
    expect(await statusOf(id)).toBe('ACTIVE'); // unchanged despite the fetch error
  });

  // ── Live campaign status sync (pause/resume done directly in Ads Manager) ────────
  it('mirrors a pause done in Ads Manager: FB PAUSED → DB PAUSED, KEEPS the channel, notifies', async () => {
    const id = await makeCampaign('fbcamp-4', 'ACTIVE');
    const releaseChannel = vi.fn(async () => ({ released: false }));
    const resync = vi.fn(async () => undefined);
    const notify = vi.fn();

    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, { effectiveStatus: 'PAUSED', accountId: 'act_test', adSets: [], ads: [{ fbAdId: 'a1', effectiveStatus: 'PAUSED' }] }),
      releaseChannel,
      resync,
      notify,
    });

    expect(res.rejected).toBe(0);
    expect(res.statusSynced).toBe(1);
    expect(await statusOf(id)).toBe('PAUSED');
    // Pause is reversible → the channel is retained (only rejection/archival releases it).
    expect(releaseChannel).not.toHaveBeenCalled();
    // KV re-published so the redirect goes active:false while the campaign keeps its channel.
    expect(resync).toHaveBeenCalledWith(id);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]?.type).toBe('campaign.status_synced');
    expect(notify.mock.calls[0]?.[0]?.title).toBe('Campaign paused');
  });

  it('treats FB CAMPAIGN_PAUSED the same as PAUSED', async () => {
    const id = await makeCampaign('fbcamp-4b', 'ACTIVE');
    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, { effectiveStatus: 'CAMPAIGN_PAUSED', accountId: 'act_test', adSets: [], ads: [] }),
      releaseChannel: vi.fn(async () => ({ released: false })),
      resync: vi.fn(async () => undefined),
      notify: vi.fn(),
    });
    expect(res.statusSynced).toBe(1);
    expect(await statusOf(id)).toBe('PAUSED');
  });

  it('mirrors a resume done in Ads Manager: FB ACTIVE on a PAUSED campaign → DB ACTIVE', async () => {
    const id = await makeCampaign('fbcamp-5', 'PAUSED');
    const releaseChannel = vi.fn(async () => ({ released: false }));
    const resync = vi.fn(async () => undefined);
    const notify = vi.fn();

    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, { effectiveStatus: 'ACTIVE', accountId: 'act_test', adSets: [], ads: [{ fbAdId: 'a1', effectiveStatus: 'ACTIVE' }] }),
      releaseChannel,
      resync,
      notify,
    });

    expect(res.rejected).toBe(0);
    expect(res.statusSynced).toBe(1);
    expect(await statusOf(id)).toBe('ACTIVE');
    expect(releaseChannel).not.toHaveBeenCalled();
    expect(resync).toHaveBeenCalledWith(id);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]?.title).toBe('Campaign resumed');
  });

  it('disapproval takes precedence over a pause: FB PAUSED + a DISAPPROVED ad → META_REJECTED (channel released)', async () => {
    const id = await makeCampaign('fbcamp-6', 'ACTIVE');
    const releaseChannel = vi.fn(async () => ({ released: true }));
    const resync = vi.fn(async () => undefined);
    const notify = vi.fn();

    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, { effectiveStatus: 'PAUSED', accountId: 'act_test', adSets: [], ads: [{ fbAdId: 'a1', effectiveStatus: 'DISAPPROVED' }] }),
      releaseChannel,
      resync,
      notify,
    });

    expect(res.rejected).toBe(1);
    expect(res.statusSynced).toBe(0);
    expect(await statusOf(id)).toBe('META_REJECTED');
    expect(releaseChannel).toHaveBeenCalledWith(id);
    expect(notify.mock.calls[0]?.[0]?.type).toBe('campaign.meta_rejected');
  });

  it('leaves the campaign alone for TRANSIENT FB review states (not ACTIVE/PAUSED/ARCHIVED)', async () => {
    const id = await makeCampaign('fbcamp-7', 'ACTIVE');
    const releaseChannel = vi.fn(async () => ({ released: false }));
    const resync = vi.fn(async () => undefined);
    const notify = vi.fn();

    for (const effectiveStatus of ['IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'PREAPPROVED', '']) {
      const res = await reconcileCampaigns({
        fetchDelivery: onlyFor(id, { effectiveStatus, accountId: 'act_test', adSets: [], ads: [] }),
        releaseChannel,
        resync,
        notify,
      });
      expect(res.statusSynced).toBe(0);
      expect(res.rejected).toBe(0);
    }
    expect(await statusOf(id)).toBe('ACTIVE');
    expect(releaseChannel).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('mirrors an archive done in Ads Manager: FB ARCHIVED → DB ARCHIVED + releases the channel', async () => {
    const id = await makeCampaign('fbcamp-arch', 'ACTIVE');
    const releaseChannel = vi.fn(async () => ({ released: true }));
    const resync = vi.fn(async () => undefined);
    const notify = vi.fn();

    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, { effectiveStatus: 'ARCHIVED', accountId: 'act_test', adSets: [], ads: [] }),
      releaseChannel,
      resync,
      notify,
    });

    expect(res.statusSynced).toBe(1);
    expect(await statusOf(id)).toBe('ARCHIVED');
    expect(releaseChannel).toHaveBeenCalledWith(id); // archive is terminal → free the channel
    expect(resync).toHaveBeenCalledWith(id);
    expect(notify.mock.calls[0]?.[0]?.title).toBe('Campaign archived');
  });

  it('treats FB DELETED the same as ARCHIVED', async () => {
    const id = await makeCampaign('fbcamp-del', 'PAUSED');
    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, { effectiveStatus: 'DELETED', accountId: 'act_test', adSets: [], ads: [] }),
      releaseChannel: vi.fn(async () => ({ released: true })),
      resync: vi.fn(async () => undefined),
      notify: vi.fn(),
    });
    expect(res.statusSynced).toBe(1);
    expect(await statusOf(id)).toBe('ARCHIVED');
  });

  // ── Per-ad-set / per-ad status mirror ───────────────────────────────────────────
  it('mirrors per-ad-set and per-ad effective_status into the DB', async () => {
    const id = await makeCampaign('fbcamp-sub-1', 'ACTIVE');
    const ids = await makeAdSetWithAd(id, 'fbset-1', 'fbad-1');

    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, {
        effectiveStatus: 'ACTIVE',
        accountId: 'act_test', adSets: [{ fbAdSetId: 'fbset-1', effectiveStatus: 'WITH_ISSUES' }],
        ads: [{ fbAdId: 'fbad-1', effectiveStatus: 'PAUSED' }],
      }),
      releaseChannel: vi.fn(async () => ({ released: false })),
      resync: vi.fn(async () => undefined),
      notify: vi.fn(),
    });

    expect(res.subSynced).toBe(2);
    expect(res.statusSynced).toBe(0); // campaign itself unchanged (ACTIVE↔ACTIVE)
    const got = await subStatusOf(ids);
    expect(got.set).toBe('WITH_ISSUES');
    expect(got.ad).toBe('PAUSED');
  });

  it('only writes sub-entities whose status changed (no churn on re-poll)', async () => {
    const id = await makeCampaign('fbcamp-sub-2', 'ACTIVE');
    await makeAdSetWithAd(id, 'fbset-2', 'fbad-2');
    const delivery = {
      effectiveStatus: 'ACTIVE',
      accountId: 'act_test', adSets: [{ fbAdSetId: 'fbset-2', effectiveStatus: 'ACTIVE' }],
      ads: [{ fbAdId: 'fbad-2', effectiveStatus: 'ACTIVE' }],
    };
    const deps = {
      releaseChannel: vi.fn(async () => ({ released: false })),
      resync: vi.fn(async () => undefined),
      notify: vi.fn(),
    };

    const first = await reconcileCampaigns({ fetchDelivery: onlyFor(id, delivery), ...deps });
    expect(first.subSynced).toBe(2); // null → ACTIVE on both rows
    const second = await reconcileCampaigns({ fetchDelivery: onlyFor(id, delivery), ...deps });
    expect(second.subSynced).toBe(0); // unchanged → no writes
  });

  it('records the DISAPPROVED ad status even while rejecting the campaign', async () => {
    const id = await makeCampaign('fbcamp-sub-3', 'ACTIVE');
    const ids = await makeAdSetWithAd(id, 'fbset-3', 'fbad-3');

    const res = await reconcileCampaigns({
      fetchDelivery: onlyFor(id, {
        effectiveStatus: 'ACTIVE',
        accountId: 'act_test', adSets: [{ fbAdSetId: 'fbset-3', effectiveStatus: 'ACTIVE' }],
        ads: [{ fbAdId: 'fbad-3', effectiveStatus: 'DISAPPROVED' }],
      }),
      releaseChannel: vi.fn(async () => ({ released: true })),
      resync: vi.fn(async () => undefined),
      notify: vi.fn(),
    });

    expect(res.rejected).toBe(1);
    expect(res.subSynced).toBe(2); // set ACTIVE + ad DISAPPROVED both recorded before rejection
    expect(await statusOf(id)).toBe('META_REJECTED');
    const got = await subStatusOf(ids);
    expect(got.set).toBe('ACTIVE');
    expect(got.ad).toBe('DISAPPROVED');
  });
});
