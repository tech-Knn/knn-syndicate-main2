import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { checkMetaRejections } from './meta-rejection.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';

async function makeActiveCampaign(fbCampaignId: string | null): Promise<string> {
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: { orgId, buyerId, name: `MR ${Math.random()}`, status: 'ACTIVE', keywords: [], fbCampaignId },
    }),
  );
  return c.id;
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

describe('checkMetaRejections', () => {
  it('flags a campaign with a DISAPPROVED ad → META_REJECTED + releases channel + notifies', async () => {
    const id = await makeActiveCampaign('fbcamp-1');
    const releaseChannel = vi.fn(async () => ({ released: true }));
    const notify = vi.fn();

    const res = await checkMetaRejections({
      fetchStatuses: async () => [{ fbAdId: 'a1', effectiveStatus: 'ACTIVE' }, { fbAdId: 'a2', effectiveStatus: 'DISAPPROVED' }],
      releaseChannel,
      notify,
    });

    expect(res.rejected).toBe(1);
    expect(releaseChannel).toHaveBeenCalledWith(id);
    expect(notify).toHaveBeenCalledTimes(1);
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id }, select: { status: true } }));
    expect(c?.status).toBe('META_REJECTED');
  });

  it('leaves an all-ACTIVE campaign untouched', async () => {
    const id = await makeActiveCampaign('fbcamp-2');
    const releaseChannel = vi.fn(async () => ({ released: false }));

    const res = await checkMetaRejections({
      fetchStatuses: async () => [{ fbAdId: 'a1', effectiveStatus: 'ACTIVE' }],
      releaseChannel,
      notify: vi.fn(),
    });

    expect(res.rejected).toBe(0);
    expect(releaseChannel).not.toHaveBeenCalled();
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id }, select: { status: true } }));
    expect(c?.status).toBe('ACTIVE');
  });

  it('skips campaigns whose status fetch throws (keeps going)', async () => {
    await makeActiveCampaign('fbcamp-3');
    const res = await checkMetaRejections({
      fetchStatuses: async () => {
        throw new Error('FB down');
      },
      releaseChannel: vi.fn(async () => ({ released: false })),
      notify: vi.fn(),
    });
    expect(res.checked).toBe(1);
    expect(res.rejected).toBe(0);
  });
});
