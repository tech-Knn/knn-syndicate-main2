import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

async function statusOf(id: string): Promise<string | undefined> {
  const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id }, select: { status: true } }));
  return c?.status;
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
      fetchDelivery: async () => ({
        effectiveStatus: 'ACTIVE',
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
      fetchDelivery: async () => ({ effectiveStatus: 'ACTIVE', ads: [{ fbAdId: 'a1', effectiveStatus: 'ACTIVE' }] }),
      releaseChannel,
      resync,
      notify,
    });

    expect(res.rejected).toBe(0);
    expect(res.statusSynced).toBe(0);
    expect(releaseChannel).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('skips campaigns whose delivery fetch throws (keeps going)', async () => {
    await makeCampaign('fbcamp-3');
    const res = await reconcileCampaigns({
      fetchDelivery: async () => {
        throw new Error('FB down');
      },
      releaseChannel: vi.fn(async () => ({ released: false })),
      resync: vi.fn(async () => undefined),
      notify: vi.fn(),
    });
    expect(res.checked).toBe(1);
    expect(res.rejected).toBe(0);
    expect(res.statusSynced).toBe(0);
  });

  // ── Live status sync (pause/resume done directly in Ads Manager) ────────────────
  it('mirrors a pause done in Ads Manager: FB PAUSED → DB PAUSED, KEEPS the channel, notifies', async () => {
    const id = await makeCampaign('fbcamp-4', 'ACTIVE');
    const releaseChannel = vi.fn(async () => ({ released: false }));
    const resync = vi.fn(async () => undefined);
    const notify = vi.fn();

    const res = await reconcileCampaigns({
      fetchDelivery: async () => ({ effectiveStatus: 'PAUSED', ads: [{ fbAdId: 'a1', effectiveStatus: 'PAUSED' }] }),
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
      fetchDelivery: async () => ({ effectiveStatus: 'CAMPAIGN_PAUSED', ads: [] }),
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
      fetchDelivery: async () => ({ effectiveStatus: 'ACTIVE', ads: [{ fbAdId: 'a1', effectiveStatus: 'ACTIVE' }] }),
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
      fetchDelivery: async () => ({ effectiveStatus: 'PAUSED', ads: [{ fbAdId: 'a1', effectiveStatus: 'DISAPPROVED' }] }),
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

  it('leaves the campaign alone for archived/transient FB statuses (no auto-archive)', async () => {
    const id = await makeCampaign('fbcamp-7', 'ACTIVE');
    const releaseChannel = vi.fn(async () => ({ released: false }));
    const resync = vi.fn(async () => undefined);
    const notify = vi.fn();

    for (const effectiveStatus of ['ARCHIVED', 'DELETED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', '']) {
      const res = await reconcileCampaigns({
        fetchDelivery: async () => ({ effectiveStatus, ads: [] }),
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
});
