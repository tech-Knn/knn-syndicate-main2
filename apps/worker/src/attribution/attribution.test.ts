import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { encryptToken, type FbAdInsightRow } from '@knn/fb';
import type { ChannelDayRevenue } from '@knn/adsense';
import { ROLES, USER_STATUS } from '@knn/shared';
import {
  type AttributionDeps,
  allocateRevenueForCampaignDay,
  recentDays,
  runAttribution,
} from './attribution.service.js';
import { getUsdRate } from './fx.service.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';
let connId = '';
let chCounter = 0;

const DAY = '2026-05-20';

interface SeededAd {
  id: string;
  fbAdId: string;
}
interface Seeded {
  campaignId: string;
  ads: SeededAd[];
  channelRef: string;
  channelCh: string;
}

/** Create a launched campaign with N ads, its own ad account (currency), a channel,
 *  and a channel-assignment span for `day` — the full graph attribution walks. */
async function seedCampaign(opts: {
  day?: string;
  currency?: string;
  adCount: number;
  buyerCut?: number | null;
}): Promise<Seeded> {
  const day = opts.day ?? DAY;
  const currency = opts.currency ?? 'USD';
  return withSystem(async (tx) => {
    if (opts.buyerCut !== undefined) {
      await tx.user.update({ where: { id: buyerId }, data: { revenueCutPct: opts.buyerCut } });
    }
    const account = await tx.fbAdAccount.create({
      data: { orgId, connectionId: connId, fbAccountId: `act_${chCounter}`, name: 'Acct', currency, timezone: 'Asia/Kolkata', status: '1' },
    });
    const channelCh = `ch-${suffix}-${chCounter++}`;
    const channel = await tx.channel.create({ data: { channelId: channelCh, status: 'ASSIGNED' } });
    const campaign = await tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: `attr ${Math.random()}`,
        status: 'ACTIVE',
        keywords: [],
        fbCampaignId: `fbcamp-${channelCh}`,
        adAccountId: account.id,
        channelId: channel.id,
      },
    });
    await tx.channel.update({ where: { id: channel.id }, data: { currentCampaignId: campaign.id, lockedForDay: day } });
    await tx.channelAssignment.create({ data: { orgId, channelRef: channel.id, campaignId: campaign.id, forDay: day } });
    const adSet = await tx.adSet.create({ data: { orgId, campaignId: campaign.id, name: 'set', pxeEvent: 'search' } });
    const ads: SeededAd[] = [];
    for (let i = 0; i < opts.adCount; i++) {
      const fbAdId = `fbad-${channelCh}-${i}`;
      const ad = await tx.ad.create({
        data: { orgId, adSetId: adSet.id, name: `ad${i}`, headline: 'h', primaryText: 'p', redirectId: randomUUID(), fbAdId },
      });
      ads.push({ id: ad.id, fbAdId });
    }
    return { campaignId: campaign.id, ads, channelRef: channel.id, channelCh };
  });
}

/** Build injected deps that return fixed FB insights + AdSense revenue for a seed. */
function depsFor(
  seed: Seeded,
  fb: { fbAdId: string; impressions: number; clicks: number; conversions: number; spendMinor: number }[],
  adsense: { revenueMinor: number; currency: string; afsClicks: number } | null,
  day = DAY,
): AttributionDeps {
  return {
    fetchInsights: async (): Promise<FbAdInsightRow[]> => fb.map((r) => ({ ...r, day })),
    fetchAdsense: adsense
      ? async (): Promise<ChannelDayRevenue[]> => [{ channelId: seed.channelCh, day, ...adsense }]
      : undefined,
    getRate: getUsdRate,
  };
}

async function adRevByFbId(seed: Seeded, day = DAY): Promise<Map<string, { allocated: number; visible: number; margin: number; basis: string }>> {
  const rows = await withSystem((tx) =>
    tx.adRevenueDaily.findMany({ where: { campaignId: seed.campaignId, day } }),
  );
  const byAdId = new Map(rows.map((r) => [r.adId, r]));
  const out = new Map<string, { allocated: number; visible: number; margin: number; basis: string }>();
  for (const ad of seed.ads) {
    const r = byAdId.get(ad.id);
    if (r) out.set(ad.fbAdId, { allocated: r.allocatedUsdMinor, visible: r.visibleUsdMinor, margin: r.marginUsdMinor, basis: r.basis });
  }
  return out;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Attr Co', slug: `attr-${suffix}`, defaultRevenueCutPct: 0.3 } });
    orgId = org.id;
    const buyer = await tx.user.create({
      data: { orgId, email: `attr-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
    });
    buyerId = buyer.id;
    const conn = await tx.fbConnection.create({
      data: { orgId, userId: buyerId, fbUserId: 'fb', accessTokenEnc: encryptToken('tok'), tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) },
    });
    connId = conn.id;
    // EUR rate for the currency-conversion test: 1 EUR = 1.10 USD.
    await tx.fxRate.upsert({ where: { day_currency: { day: DAY, currency: 'EUR' } }, create: { day: DAY, currency: 'EUR', rate: 1.1 }, update: { rate: 1.1 } });
  });
});

beforeEach(async () => {
  await withSystem(async (tx) => {
    await tx.adRevenueDaily.deleteMany({ where: { orgId } });
    await tx.adStatsDaily.deleteMany({ where: { orgId } });
    await tx.campaignRevenueDaily.deleteMany({ where: { orgId } });
    await tx.channelAssignment.deleteMany({ where: { orgId } });
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `ch-${suffix}` } } });
    await tx.fbAdAccount.deleteMany({ where: { orgId } });
    await tx.user.update({ where: { id: buyerId }, data: { revenueCutPct: null } });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.adRevenueDaily.deleteMany({ where: { orgId } });
    await tx.adStatsDaily.deleteMany({ where: { orgId } });
    await tx.campaignRevenueDaily.deleteMany({ where: { orgId } });
    await tx.channelAssignment.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `ch-${suffix}` } } });
    await tx.fxRate.deleteMany({ where: { currency: 'EUR', day: DAY } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('attribution — conversion-weighted allocation (D8) end-to-end', () => {
  it('worked example: $50 revenue, one converting ad takes all of it (30% cut)', async () => {
    const seed = await seedCampaign({ adCount: 2 });
    const deps = depsFor(
      seed,
      [
        { fbAdId: seed.ads[0]!.fbAdId, impressions: 100, clicks: 9, conversions: 1, spendMinor: 1000 },
        { fbAdId: seed.ads[1]!.fbAdId, impressions: 200, clicks: 30, conversions: 0, spendMinor: 2000 },
      ],
      { revenueMinor: 5000, currency: 'USD', afsClicks: 40 },
    );
    await runAttribution([DAY], deps);

    const rev = await adRevByFbId(seed);
    expect(rev.get(seed.ads[0]!.fbAdId)).toEqual({ allocated: 5000, visible: 3500, margin: 1500, basis: 'conversions' });
    expect(rev.get(seed.ads[1]!.fbAdId)).toEqual({ allocated: 0, visible: 0, margin: 0, basis: 'conversions' });
  });

  it('worked example: $50 across 4 ads with 1 conversion each → $12.50 each', async () => {
    const seed = await seedCampaign({ adCount: 4 });
    const deps = depsFor(
      seed,
      seed.ads.map((a) => ({ fbAdId: a.fbAdId, impressions: 10, clicks: 1, conversions: 1, spendMinor: 100 })),
      { revenueMinor: 5000, currency: 'USD', afsClicks: 80 },
    );
    await runAttribution([DAY], deps);

    const rev = await adRevByFbId(seed);
    for (const ad of seed.ads) {
      expect(rev.get(ad.fbAdId)).toEqual({ allocated: 1250, visible: 875, margin: 375, basis: 'conversions' });
    }
  });

  it('zero-conversion fallback splits by clicks, then exact-sums to the gross', async () => {
    const seed = await seedCampaign({ adCount: 2 });
    const deps = depsFor(
      seed,
      [
        { fbAdId: seed.ads[0]!.fbAdId, impressions: 100, clicks: 3, conversions: 0, spendMinor: 0 },
        { fbAdId: seed.ads[1]!.fbAdId, impressions: 100, clicks: 1, conversions: 0, spendMinor: 0 },
      ],
      { revenueMinor: 5000, currency: 'USD', afsClicks: 40 },
    );
    await runAttribution([DAY], deps);

    const rev = await adRevByFbId(seed);
    expect(rev.get(seed.ads[0]!.fbAdId)!.allocated).toBe(3750);
    expect(rev.get(seed.ads[1]!.fbAdId)!.allocated).toBe(1250);
    expect(rev.get(seed.ads[0]!.fbAdId)!.basis).toBe('clicks');
  });

  it('holds revenue unallocated when an ad has revenue but no conversions/clicks/impressions', async () => {
    const seed = await seedCampaign({ adCount: 1 });
    const deps = depsFor(
      seed,
      [{ fbAdId: seed.ads[0]!.fbAdId, impressions: 0, clicks: 0, conversions: 0, spendMinor: 0 }],
      { revenueMinor: 5000, currency: 'USD', afsClicks: 40 },
    );
    await runAttribution([DAY], deps);

    const rev = await adRevByFbId(seed);
    expect(rev.get(seed.ads[0]!.fbAdId)).toEqual({ allocated: 0, visible: 0, margin: 0, basis: 'unallocated' });
    // The campaign still has the gross — it's just unallocated.
    const camp = await withSystem((tx) => tx.campaignRevenueDaily.findUnique({ where: { campaignId_day: { campaignId: seed.campaignId, day: DAY } } }));
    expect(camp!.revenueUsdMinor).toBe(5000);
  });
});

describe('attribution — currency (D15), suppression, revenue cut', () => {
  it('converts native FB spend to USD via the daily FxRate', async () => {
    const seed = await seedCampaign({ adCount: 1, currency: 'EUR' });
    const deps = depsFor(
      seed,
      [{ fbAdId: seed.ads[0]!.fbAdId, impressions: 50, clicks: 5, conversions: 2, spendMinor: 1000 }],
      { revenueMinor: 2000, currency: 'USD', afsClicks: 20 },
    );
    await runAttribution([DAY], deps);

    const stat = await withSystem((tx) => tx.adStatsDaily.findUnique({ where: { adId_day: { adId: seed.ads[0]!.id, day: DAY } } }));
    expect(stat!.spendMinor).toBe(1000); // native EUR cents
    expect(stat!.spendUsdMinor).toBe(1100); // €10.00 × 1.10 = $11.00
    expect(stat!.currency).toBe('EUR');
  });

  it('marks revenue suppressed when AFS clicks < threshold (10)', async () => {
    const lo = await seedCampaign({ adCount: 1 });
    await runAttribution([DAY], depsFor(lo, [{ fbAdId: lo.ads[0]!.fbAdId, impressions: 1, clicks: 1, conversions: 1, spendMinor: 0 }], { revenueMinor: 100, currency: 'USD', afsClicks: 5 }));
    const loRow = await withSystem((tx) => tx.campaignRevenueDaily.findUnique({ where: { campaignId_day: { campaignId: lo.campaignId, day: DAY } } }));
    expect(loRow!.suppressed).toBe(true);

    const hi = await seedCampaign({ adCount: 1 });
    await runAttribution([DAY], depsFor(hi, [{ fbAdId: hi.ads[0]!.fbAdId, impressions: 1, clicks: 1, conversions: 1, spendMinor: 0 }], { revenueMinor: 100, currency: 'USD', afsClicks: 50 }));
    const hiRow = await withSystem((tx) => tx.campaignRevenueDaily.findUnique({ where: { campaignId_day: { campaignId: hi.campaignId, day: DAY } } }));
    expect(hiRow!.suppressed).toBe(false);
  });

  it('applies the buyer cut override instead of the org default', async () => {
    const seed = await seedCampaign({ adCount: 1, buyerCut: 0.5 }); // 50% override (org default is 30%)
    const deps = depsFor(seed, [{ fbAdId: seed.ads[0]!.fbAdId, impressions: 1, clicks: 1, conversions: 1, spendMinor: 0 }], { revenueMinor: 1000, currency: 'USD', afsClicks: 20 });
    await runAttribution([DAY], deps);
    const rev = await adRevByFbId(seed);
    expect(rev.get(seed.ads[0]!.fbAdId)).toEqual({ allocated: 1000, visible: 500, margin: 500, basis: 'conversions' });
  });
});

describe('attribution — finalization re-pull idempotency (§5.8)', () => {
  it('re-running attribution for the same day does not double-count', async () => {
    const seed = await seedCampaign({ adCount: 2 });
    const deps = depsFor(
      seed,
      [
        { fbAdId: seed.ads[0]!.fbAdId, impressions: 100, clicks: 9, conversions: 3, spendMinor: 1500 },
        { fbAdId: seed.ads[1]!.fbAdId, impressions: 100, clicks: 9, conversions: 1, spendMinor: 1500 },
      ],
      { revenueMinor: 4000, currency: 'USD', afsClicks: 40 },
    );
    await runAttribution([DAY], deps);
    await runAttribution([DAY], deps); // re-pull (finalization window)

    // Exactly one row per (ad, day) — upserts, not inserts.
    const statCount = await withSystem((tx) => tx.adStatsDaily.count({ where: { campaignId: seed.campaignId, day: DAY } }));
    const revCount = await withSystem((tx) => tx.adRevenueDaily.count({ where: { campaignId: seed.campaignId, day: DAY } }));
    expect(statCount).toBe(2);
    expect(revCount).toBe(2);

    const rev = await adRevByFbId(seed);
    // 3:1 conversion split of $40.00 → $30 / $10 (stable across re-runs).
    expect(rev.get(seed.ads[0]!.fbAdId)!.allocated).toBe(3000);
    expect(rev.get(seed.ads[1]!.fbAdId)!.allocated).toBe(1000);
    // Allocated shares sum exactly to the campaign gross.
    const sum = [...rev.values()].reduce((a, r) => a + r.allocated, 0);
    expect(sum).toBe(4000);
  });
});

describe('allocateRevenueForCampaignDay (direct, no revenue row)', () => {
  it('is a no-op when the campaign has no revenue for the day', async () => {
    const seed = await seedCampaign({ adCount: 1 });
    const written = await withSystem((tx) => allocateRevenueForCampaignDay(tx, seed.campaignId, DAY));
    expect(written).toBe(0);
  });
});

describe('recentDays', () => {
  it('returns the trailing window inclusive of the end day, in order', () => {
    expect(recentDays('2026-05-20', 3)).toEqual(['2026-05-18', '2026-05-19', '2026-05-20']);
    expect(recentDays('2026-03-01', 2)).toEqual(['2026-02-28', '2026-03-01']);
  });
});
