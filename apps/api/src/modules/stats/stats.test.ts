import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { type TxClient, prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { ROLES, USER_STATUS, addBusinessDays, currentBusinessDay } from '@knn/shared';
import type { CampaignBreakdown, CampaignPerf, StatsSummary } from '@knn/shared';
import { hashPassword } from '../../lib/password.js';
import { buildApp } from '../../app.js';

const suffix = Date.now().toString(36);
const PW = 'stats-pw-123456';
const today = currentBusinessDay();
const yesterday = addBusinessDays(today, -1);

let app: FastifyInstance;
let orgAId = '';
let orgBId = '';
const ids = {} as { cA1: string; cA2: string; cB1: string; ad1: string; ad2: string };

const buyerA1 = `stats-b1-${suffix}@a.com`;
const buyerA2 = `stats-b2-${suffix}@a.com`;
const adminA = `stats-admin-a-${suffix}@a.com`;
const adminB = `stats-admin-b-${suffix}@a.com`;
const superE = `stats-super-${suffix}@a.com`;

async function bearer(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  return res.json<{ accessToken: string }>().accessToken;
}
function h(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function seedDay(
  tx: TxClient,
  orgId: string,
  campaignId: string,
  adId: string,
  day: string,
  s: { spend: number; impr: number; clicks: number; conv: number },
  r: { visible: number; margin: number },
): Promise<void> {
  await tx.adStatsDaily.create({
    data: {
      orgId,
      campaignId,
      adId,
      day,
      spendUsdMinor: s.spend,
      spendMinor: s.spend,
      currency: 'USD',
      impressions: s.impr,
      clicks: s.clicks,
      conversions: s.conv,
    },
  });
  await tx.adRevenueDaily.create({
    data: {
      orgId,
      campaignId,
      adId,
      day,
      conversions: s.conv,
      allocatedUsdMinor: r.visible + r.margin,
      visibleUsdMinor: r.visible,
      marginUsdMinor: r.margin,
      basis: 'conversions',
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await withSystem(async (tx) => {
    const pw = await hashPassword(PW);
    orgAId = (await tx.organization.create({ data: { name: 'Stats A', slug: `stats-a-${suffix}` } })).id;
    orgBId = (await tx.organization.create({ data: { name: 'Stats B', slug: `stats-b-${suffix}` } })).id;

    const b1 = await tx.user.create({ data: { orgId: orgAId, email: buyerA1, name: 'Buyer A1', passwordHash: pw, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } });
    const b2 = await tx.user.create({ data: { orgId: orgAId, email: buyerA2, name: 'Buyer A2', passwordHash: pw, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } });
    await tx.user.create({ data: { orgId: orgAId, email: adminA, name: 'Admin A', passwordHash: pw, role: ROLES.COMPANY_ADMIN, status: USER_STATUS.ACTIVE } });
    await tx.user.create({ data: { orgId: orgBId, email: adminB, name: 'Admin B', passwordHash: pw, role: ROLES.COMPANY_ADMIN, status: USER_STATUS.ACTIVE } });
    await tx.user.create({ data: { orgId: orgAId, email: superE, name: 'Super', passwordHash: pw, role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE } });
    const bB = await tx.user.create({ data: { orgId: orgBId, email: `stats-bB-${suffix}@b.com`, name: 'Buyer B', passwordHash: pw, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } });

    // Campaign A1 (buyer A1): 1 ad set, 2 ads.
    const cA1 = await tx.campaign.create({ data: { orgId: orgAId, buyerId: b1.id, name: 'Camp A1', status: 'ACTIVE' } });
    ids.cA1 = cA1.id;
    const sA1 = await tx.adSet.create({ data: { orgId: orgAId, campaignId: cA1.id, name: 'Set A1' } });
    const ad1 = await tx.ad.create({ data: { orgId: orgAId, adSetId: sA1.id, name: 'Ad 1', headline: 'H', primaryText: 'P', redirectId: `r-${suffix}-1` } });
    const ad2 = await tx.ad.create({ data: { orgId: orgAId, adSetId: sA1.id, name: 'Ad 2', headline: 'H', primaryText: 'P', redirectId: `r-${suffix}-2` } });
    ids.ad1 = ad1.id;
    ids.ad2 = ad2.id;

    // Campaign A2 (buyer A2): 1 ad set, 1 ad.
    const cA2 = await tx.campaign.create({ data: { orgId: orgAId, buyerId: b2.id, name: 'Camp A2', status: 'ACTIVE' } });
    ids.cA2 = cA2.id;
    const sA2 = await tx.adSet.create({ data: { orgId: orgAId, campaignId: cA2.id, name: 'Set A2' } });
    const ad3 = await tx.ad.create({ data: { orgId: orgAId, adSetId: sA2.id, name: 'Ad 3', headline: 'H', primaryText: 'P', redirectId: `r-${suffix}-3` } });

    // Campaign B1 (org B).
    const cB1 = await tx.campaign.create({ data: { orgId: orgBId, buyerId: bB.id, name: 'Camp B1', status: 'ACTIVE' } });
    ids.cB1 = cB1.id;
    const sB1 = await tx.adSet.create({ data: { orgId: orgBId, campaignId: cB1.id, name: 'Set B1' } });
    const ad4 = await tx.ad.create({ data: { orgId: orgBId, adSetId: sB1.id, name: 'Ad 4', headline: 'H', primaryText: 'P', redirectId: `r-${suffix}-4` } });

    // --- daily seed (USD minor units) ---
    // A1: today ad1 spend $20 rev $50 (margin $10); ad2 spend $10 rev $25 (margin $5);
    //     yesterday ad1 spend $15 rev $30 (margin $6).
    await seedDay(tx, orgAId, cA1.id, ad1.id, today, { spend: 2000, impr: 1000, clicks: 50, conv: 2 }, { visible: 5000, margin: 1000 });
    await seedDay(tx, orgAId, cA1.id, ad2.id, today, { spend: 1000, impr: 500, clicks: 20, conv: 1 }, { visible: 2500, margin: 500 });
    await seedDay(tx, orgAId, cA1.id, ad1.id, yesterday, { spend: 1500, impr: 800, clicks: 30, conv: 1 }, { visible: 3000, margin: 600 });
    // A2: today $40 spend, $80 rev (margin $20).
    await seedDay(tx, orgAId, cA2.id, ad3.id, today, { spend: 4000, impr: 3000, clicks: 100, conv: 3 }, { visible: 8000, margin: 2000 });
    // B1: today (org B).
    await seedDay(tx, orgBId, cB1.id, ad4.id, today, { spend: 9999, impr: 1234, clicks: 99, conv: 9 }, { visible: 9999, margin: 999 });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  });
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

describe('stats read API', () => {
  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/stats/summary' })).statusCode).toBe(401);
  });

  it('buyer summary covers only their own campaign (A1), over the default 7-day range', async () => {
    const token = await bearer(buyerA1);
    const res = await app.inject({ method: 'GET', url: '/api/stats/summary', headers: h(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json<StatsSummary>();
    // A1 = today (ad1+ad2) + yesterday (ad1): spend 45, revenue 105.
    expect(body.totals.spendUsd).toBe(45);
    expect(body.totals.revenueUsd).toBe(105);
    expect(body.totals.profitUsd).toBe(60);
    expect(body.totals.roi).toBeCloseTo(2.3333, 3);
    expect(body.totals.impressions).toBe(2300);
    expect(body.totals.clicks).toBe(100);
    expect(body.totals.conversions).toBe(4);
    expect(body.totals.marginUsd).toBe(0); // buyers never see platform margin
    expect(body.series).toHaveLength(7);
    const todayPt = body.series.find((p) => p.day === today)!;
    const yestPt = body.series.find((p) => p.day === yesterday)!;
    expect(todayPt).toMatchObject({ spendUsd: 30, revenueUsd: 75, profitUsd: 45 });
    expect(yestPt).toMatchObject({ spendUsd: 15, revenueUsd: 30 });
  });

  it('respects a narrow range (today only excludes yesterday)', async () => {
    const token = await bearer(buyerA1);
    const res = await app.inject({ method: 'GET', url: `/api/stats/summary?from=${today}&to=${today}`, headers: h(token) });
    const body = res.json<StatsSummary>();
    expect(body.series).toHaveLength(1);
    expect(body.totals.spendUsd).toBe(30);
    expect(body.totals.revenueUsd).toBe(75);
  });

  it('company-admin summary rolls up the whole org (A1 + A2) incl. platform margin, excludes org B', async () => {
    const token = await bearer(adminA);
    const body = (await app.inject({ method: 'GET', url: '/api/stats/summary', headers: h(token) })).json<StatsSummary>();
    expect(body.totals.spendUsd).toBe(85); // 45 (A1) + 40 (A2)
    expect(body.totals.revenueUsd).toBe(185); // 105 + 80
    expect(body.totals.marginUsd).toBe(41); // A1: $10+$5+$6 (16) + A2: $20
  });

  it('buyer campaign-performance list shows only their campaigns with ad-set/ad counts', async () => {
    const token = await bearer(buyerA1);
    const body = (await app.inject({ method: 'GET', url: '/api/stats/campaigns', headers: h(token) })).json<{ campaigns: CampaignPerf[] }>();
    expect(body.campaigns).toHaveLength(1);
    const c = body.campaigns[0]!;
    expect(c.id).toBe(ids.cA1);
    expect(c.adSetCount).toBe(1);
    expect(c.adCount).toBe(2);
    expect(c.spendUsd).toBe(45);
    expect(c.revenueUsd).toBe(105);
  });

  it('super-admin sees across orgs (campaign list contains org A and org B)', async () => {
    const token = await bearer(superE);
    const body = (await app.inject({ method: 'GET', url: '/api/stats/campaigns', headers: h(token) })).json<{ campaigns: CampaignPerf[] }>();
    const seen = new Set(body.campaigns.map((c) => c.id));
    expect(seen.has(ids.cA1)).toBe(true);
    expect(seen.has(ids.cA2)).toBe(true);
    expect(seen.has(ids.cB1)).toBe(true); // cross-org visibility
  });

  it('campaign breakdown returns the ad-set → ad tree with per-ad numbers', async () => {
    const token = await bearer(buyerA1);
    const body = (await app.inject({ method: 'GET', url: `/api/stats/campaigns/${ids.cA1}`, headers: h(token) })).json<CampaignBreakdown>();
    expect(body.campaign.id).toBe(ids.cA1);
    expect(body.adSets).toHaveLength(1);
    const ads = body.adSets[0]!.ads;
    expect(ads).toHaveLength(2);
    const ad1 = ads.find((a) => a.id === ids.ad1)!;
    const ad2 = ads.find((a) => a.id === ids.ad2)!;
    expect(ad1).toMatchObject({ spendUsd: 35, revenueUsd: 80 }); // today 20/50 + yest 15/30
    expect(ad2).toMatchObject({ spendUsd: 10, revenueUsd: 25 });
    expect(body.totals.spendUsd).toBe(45);
    expect(body.totals.revenueUsd).toBe(105);
  });

  it('isolates the breakdown across orgs and buyers (404)', async () => {
    const otherOrg = await bearer(adminB); // org B admin → can't see org A campaign
    expect((await app.inject({ method: 'GET', url: `/api/stats/campaigns/${ids.cA1}`, headers: h(otherOrg) })).statusCode).toBe(404);
    const otherBuyer = await bearer(buyerA2); // same org, not the owner
    expect((await app.inject({ method: 'GET', url: `/api/stats/campaigns/${ids.cA1}`, headers: h(otherBuyer) })).statusCode).toBe(404);
  });
});
