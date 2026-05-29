import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS } from '@knn/shared';
import { encryptToken } from '@knn/fb';
import { AppError } from '../../lib/errors.js';
import { submitCampaign } from './campaigns.service.js';
import { listOfferDomains, listOffers, setOffers, updateLiveOffers } from './offers.service.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';
let otherBuyerId = '';
let campaignId = '';
let afsId = '';
let domLiveA = '';
let domLiveB = '';
let domPending = '';

const auth = () => ({ userId: buyerId, orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE });

beforeAll(async () => {
  await withSystem(async (tx) => {
    orgId = (await tx.organization.create({ data: { name: 'Off Co', slug: `off-${suffix}` } })).id;
    buyerId = (await tx.user.create({ data: { orgId, email: `off-b-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    otherBuyerId = (await tx.user.create({ data: { orgId, email: `off-o-${suffix}@a.com`, name: 'O', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    campaignId = (await tx.campaign.create({ data: { orgId, buyerId, name: 'c', status: 'DRAFT', keywords: [] } })).id;
    afsId = (await tx.googleConnection.create({
      data: { accessTokenEnc: encryptToken('x'), tokenExpiresAt: new Date(Date.now() + 3_600_000), adsenseAccount: `acc-${suffix}`, adsenseAdClient: `adc-${suffix}`, afsPubId: `partner-pub-${suffix}`, label: 'AFS', status: 'ACTIVE' },
    })).id;
    domLiveA = (await tx.domain.create({ data: { host: `la-${suffix}.example.com`, afsAccountId: afsId, status: 'LIVE', verifyToken: `1-${suffix}` } })).id;
    domLiveB = (await tx.domain.create({ data: { host: `lb-${suffix}.example.com`, afsAccountId: afsId, status: 'LIVE', verifyToken: `2-${suffix}` } })).id;
    domPending = (await tx.domain.create({ data: { host: `pd-${suffix}.example.com`, afsAccountId: afsId, status: 'PENDING_DNS', verifyToken: `3-${suffix}` } })).id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.campaign.deleteMany({ where: { orgId } }); // cascades offers
    await tx.channelAssignment.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId: { contains: suffix } } });
    await tx.article.deleteMany({ where: { orgId } });
    await tx.domain.deleteMany({ where: { afsAccountId: afsId } });
    await tx.googleConnection.deleteMany({ where: { id: afsId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await closeQueues();
  await prisma.$disconnect();
});

describe('campaign offers', () => {
  it('sets a PAID + ORGANIC offer mix and lists them (channel null until assigned)', async () => {
    const rows = await setOffers(auth(), campaignId, [
      { domainId: domLiveA, weightPct: 70, kind: 'PAID' },
      { domainId: domLiveB, weightPct: 30, kind: 'PAID' },
      { domainId: domLiveA, weightPct: 0, kind: 'ORGANIC' },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.kind === 'PAID')).toHaveLength(2);
    expect(rows.every((r) => r.channelId === null)).toBe(true);
    // Replace semantics: a second set overwrites the first.
    const replaced = await setOffers(auth(), campaignId, [{ domainId: domLiveA, weightPct: 100, kind: 'PAID' }]);
    expect(replaced).toHaveLength(1);
    expect((await listOffers(auth(), campaignId)).length).toBe(1);
  });

  it('sets a per-offer article VARIANT (A/B) and returns its title', async () => {
    const variant = await withSystem((tx) =>
      tx.article.create({ data: { orgId, slug: `off-variant-${suffix}`, title: 'Off Variant', rawContent: 'r', compliantContent: 'c', status: 'READY' } }),
    );
    const rows = await setOffers(auth(), campaignId, [
      { domainId: domLiveA, weightPct: 50, kind: 'PAID', articleId: variant.id },
      { domainId: domLiveB, weightPct: 50, kind: 'PAID' }, // default article
    ]);
    const a = rows.find((r) => r.domainId === domLiveA)!;
    const b = rows.find((r) => r.domainId === domLiveB)!;
    expect(a.articleId).toBe(variant.id);
    expect(a.articleTitle).toBe('Off Variant');
    expect(b.articleId).toBeNull();
  });

  it('rejects an unknown article variant', async () => {
    await expect(
      setOffers(auth(), campaignId, [{ domainId: domLiveA, weightPct: 100, kind: 'PAID', articleId: randomUUID() }]),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects a non-READY article variant', async () => {
    const draftArticle = await withSystem((tx) =>
      tx.article.create({ data: { orgId, slug: `off-draft-${suffix}`, title: 'Draft', rawContent: 'r', compliantContent: 'c', status: 'GENERATING' } }),
    );
    await expect(
      setOffers(auth(), campaignId, [{ domainId: domLiveA, weightPct: 100, kind: 'PAID', articleId: draftArticle.id }]),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects more than one organic offer', async () => {
    await expect(
      setOffers(auth(), campaignId, [
        { domainId: domLiveA, weightPct: 0, kind: 'ORGANIC' },
        { domainId: domLiveB, weightPct: 0, kind: 'ORGANIC' },
      ]),
    ).rejects.toThrow('at most one organic');
  });

  it('rejects paid offers that are all zero-weight', async () => {
    await expect(
      setOffers(auth(), campaignId, [{ domainId: domLiveA, weightPct: 0, kind: 'PAID' }]),
    ).rejects.toThrow('weight greater than 0');
  });

  it('rejects an offer on a non-LIVE domain', async () => {
    await expect(
      setOffers(auth(), campaignId, [{ domainId: domPending, weightPct: 100, kind: 'PAID' }]),
    ).rejects.toThrow('not LIVE');
  });

  it("hides another company's domain from offer options and rejects using it", async () => {
    const otherOrg = await withSystem((tx) => tx.organization.create({ data: { name: 'Other', slug: `oth-${suffix}` } }));
    const domOther = await withSystem((tx) =>
      tx.domain.create({ data: { host: `oth-${suffix}.example.com`, afsAccountId: afsId, status: 'LIVE', verifyToken: `o-${suffix}`, ownerOrgId: otherOrg.id } }),
    );
    const opts = await listOfferDomains(auth());
    expect(opts.some((o) => o.id === domOther.id)).toBe(false); // owned by another company → hidden
    expect(opts.some((o) => o.id === domLiveA)).toBe(true); // shared → visible
    await expect(
      setOffers(auth(), campaignId, [{ domainId: domOther.id, weightPct: 100, kind: 'PAID' }]),
    ).rejects.toThrow('restricted to another company');
    await withSystem(async (tx) => {
      await tx.domain.deleteMany({ where: { id: domOther.id } });
      await tx.organization.deleteMany({ where: { id: otherOrg.id } });
    });
  });

  it("allows a domain owned by the buyer's own company", async () => {
    await withSystem((tx) => tx.domain.update({ where: { id: domLiveB }, data: { ownerOrgId: orgId } }));
    const opts = await listOfferDomains(auth());
    expect(opts.some((o) => o.id === domLiveB)).toBe(true);
    const rows = await setOffers(auth(), campaignId, [{ domainId: domLiveB, weightPct: 100, kind: 'PAID' }]);
    expect(rows).toHaveLength(1);
    await withSystem((tx) => tx.domain.update({ where: { id: domLiveB }, data: { ownerOrgId: null } }));
  });

  it('forbids another buyer from reading/editing the campaign offers', async () => {
    const otherAuth = { userId: otherBuyerId, orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE };
    await expect(listOffers(otherAuth, campaignId)).rejects.toThrow('not found');
  });

  it('blocks submit until the campaign has at least one paid offer', async () => {
    const fresh = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'no-offers', status: 'DRAFT', keywords: [] } }));
    try {
      await submitCampaign(auth(), fresh.id);
      throw new Error('expected submit to be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(422);
      expect((err as AppError).details).toEqual(expect.arrayContaining([expect.stringContaining('paid offer')]));
    }
    await withSystem((tx) => tx.campaign.deleteMany({ where: { id: fresh.id } }));
  });

  it('blocks editing once the campaign is past approval (ACTIVE)', async () => {
    await withSystem((tx) => tx.campaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE' } }));
    await expect(
      setOffers(auth(), campaignId, [{ domainId: domLiveA, weightPct: 100, kind: 'PAID' }]),
    ).rejects.toThrow('before the campaign is approved');
    await withSystem((tx) => tx.campaign.update({ where: { id: campaignId }, data: { status: 'DRAFT' } }));
  });
});

describe('live offer rebalance (post-launch, no Facebook — OQ#9)', () => {
  let liveId = '';
  let offerAId = '';
  let offerBId = '';

  beforeAll(async () => {
    await withSystem(async (tx) => {
      const art = await tx.article.create({ data: { orgId, slug: `live-art-${suffix}`, title: 'Live Art', rawContent: 'r', compliantContent: 'c', status: 'READY' } });
      liveId = (await tx.campaign.create({ data: { orgId, buyerId, name: 'live', status: 'ACTIVE', keywords: ['x'], racValue: 'x', articleId: art.id } })).id;
      const chA = await tx.channel.create({ data: { channelId: `live-a-${suffix}`, domainId: domLiveA, status: 'ASSIGNED', currentCampaignId: liveId } });
      const chB = await tx.channel.create({ data: { channelId: `live-b-${suffix}`, domainId: domLiveB, status: 'ASSIGNED', currentCampaignId: liveId } });
      offerAId = (await tx.offer.create({ data: { orgId, campaignId: liveId, domainId: domLiveA, weightPct: 50, kind: 'PAID', channelRef: chA.id } })).id;
      offerBId = (await tx.offer.create({ data: { orgId, campaignId: liveId, domainId: domLiveB, weightPct: 50, kind: 'PAID', channelRef: chB.id } })).id;
    });
  });

  it('rebalances weights on existing offers synchronously (no channel ops) + preserves channels', async () => {
    const res = await updateLiveOffers(auth(), liveId, [
      { id: offerAId, domainId: domLiveA, weightPct: 100, kind: 'PAID' },
      { id: offerBId, domainId: domLiveB, weightPct: 0, kind: 'PAID' },
    ]);
    expect(res.rebalancing).toBe(false); // weight-only → applied + KV re-synced inline
    const a = res.offers.find((o) => o.id === offerAId)!;
    expect(a.weightPct).toBe(100);
    expect(a.channelId).toBe(`live-a-${suffix}`); // channel preserved (matched by id)
    expect(res.offers.find((o) => o.id === offerBId)!.weightPct).toBe(0);
  });

  it('flags rebalancing=true when an offer is removed (channel release routed to the worker)', async () => {
    const res = await updateLiveOffers(auth(), liveId, [{ id: offerAId, domainId: domLiveA, weightPct: 100, kind: 'PAID' }]);
    expect(res.rebalancing).toBe(true);
    expect(res.offers).toHaveLength(1); // offer B deleted; its channel released asynchronously
  });

  it('rejects a live edit on a pre-launch (DRAFT) campaign', async () => {
    const draft = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'draft-live', status: 'DRAFT', keywords: ['x'] } }));
    await expect(updateLiveOffers(auth(), draft.id, [{ domainId: domLiveA, weightPct: 100, kind: 'PAID' }])).rejects.toBeInstanceOf(AppError);
    await withSystem((tx) => tx.campaign.deleteMany({ where: { id: draft.id } }));
  });
});
