import { type TxClient } from '@knn/db';
import {
  AFS_CLICK_SUPPRESSION_THRESHOLD,
  type AdPerf,
  type AdSetPerf,
  type BuyerRollup,
  type CampaignBreakdown,
  type CampaignPerf,
  type CompanyRollup,
  type DailyPoint,
  type DateRange,
  type DimStat,
  type MetricTotals,
  type OfferStat,
  ROLES,
  type StatDim,
  type StatsSummary,
  CAMPAIGN_STATUS,
  addBusinessDays,
  allocateByWeights,
  businessDaysInRange,
  centsToDollars,
  currentBusinessDay,
} from '@knn/shared';
import { QUEUES, getQueue } from '@knn/queue';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;

/**
 * Resolve the requested IST-business-day window. Defaults to the trailing 7 days
 * ending today; clamps the span to MAX_RANGE_DAYS so a crafted range can't scan
 * unbounded history. Both ends are inclusive "YYYY-MM-DD".
 */
export function parseRange(q: { from?: string; to?: string }): DateRange {
  const to = q.to && DAY_RE.test(q.to) ? q.to : currentBusinessDay();
  let from = q.from && DAY_RE.test(q.from) ? q.from : addBusinessDays(to, -6);
  if (from > to) from = to;
  const min = addBusinessDays(to, -(MAX_RANGE_DAYS - 1));
  if (from < min) from = min;
  return { from, to };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roiOf(revenueUsd: number, spendUsd: number): number {
  // True ROI = profit ÷ spend = (revenue − spend) / spend, returned as a fraction:
  // 0.20 = +20% (spend 100 → revenue 120), negative when a campaign loses money,
  // 0 at break-even (or when there's no spend). The UI renders it as a percentage.
  return spendUsd > 0 ? Math.round(((revenueUsd - spendUsd) / spendUsd) * 10000) / 10000 : 0;
}

/** Buyers see only their own campaigns; admins/super see everything in their RLS scope. */
async function buyerCampaignIds(tx: TxClient, auth: AuthContext): Promise<string[] | null> {
  if (auth.role !== ROLES.MEDIA_BUYER) return null;
  const rows = await tx.campaign.findMany({ where: { buyerId: auth.userId }, select: { id: true } });
  return rows.map((r) => r.id);
}

function dayWhere(range: DateRange, campaignIds: string[] | null) {
  return {
    day: { gte: range.from, lte: range.to },
    ...(campaignIds ? { campaignId: { in: campaignIds } } : {}),
  };
}

/** KPI totals + a per-day series (gaps zero-filled) for the actor's scope. */
export async function getSummary(auth: AuthContext, range: DateRange): Promise<StatsSummary> {
  return runScoped(auth, async (tx) => {
    const ids = await buyerCampaignIds(tx, auth);
    const where = dayWhere(range, ids);

    const [statsByDay, revByDay] = await Promise.all([
      tx.adStatsDaily.groupBy({
        by: ['day'],
        where,
        _sum: { spendUsdMinor: true, impressions: true, clicks: true, conversions: true },
      }),
      tx.adRevenueDaily.groupBy({
        by: ['day'],
        where,
        _sum: { visibleUsdMinor: true, marginUsdMinor: true },
      }),
    ]);

    const spendByDay = new Map(statsByDay.map((r) => [r.day, r._sum.spendUsdMinor ?? 0]));
    const revByDayMap = new Map(revByDay.map((r) => [r.day, r._sum.visibleUsdMinor ?? 0]));

    const series: DailyPoint[] = businessDaysInRange(range.from, range.to).map((day) => {
      const spendUsd = centsToDollars(spendByDay.get(day) ?? 0);
      const revenueUsd = centsToDollars(revByDayMap.get(day) ?? 0);
      return {
        day,
        spendUsd: round2(spendUsd),
        revenueUsd: round2(revenueUsd),
        profitUsd: round2(revenueUsd - spendUsd),
      };
    });

    let spendMinor = 0;
    let impressions = 0;
    let clicks = 0;
    let conversions = 0;
    for (const r of statsByDay) {
      spendMinor += r._sum.spendUsdMinor ?? 0;
      impressions += r._sum.impressions ?? 0;
      clicks += r._sum.clicks ?? 0;
      conversions += r._sum.conversions ?? 0;
    }
    let visibleMinor = 0;
    let marginMinor = 0;
    for (const r of revByDay) {
      visibleMinor += r._sum.visibleUsdMinor ?? 0;
      marginMinor += r._sum.marginUsdMinor ?? 0;
    }

    const spendUsd = round2(centsToDollars(spendMinor));
    const revenueUsd = round2(centsToDollars(visibleMinor));
    const totals: MetricTotals = {
      spendUsd,
      revenueUsd,
      profitUsd: round2(revenueUsd - spendUsd),
      roi: roiOf(revenueUsd, spendUsd),
      impressions,
      clicks,
      conversions,
      marginUsd: auth.role === ROLES.MEDIA_BUYER ? 0 : round2(centsToDollars(marginMinor)),
    };

    return { range, totals, series };
  });
}

/** Per-campaign performance rows (every campaign in scope, zero-filled if no data). */
export async function getCampaignPerformance(
  auth: AuthContext,
  range: DateRange,
): Promise<CampaignPerf[]> {
  return runScoped(auth, async (tx) => {
    const campaigns = await tx.campaign.findMany({
      where: auth.role === ROLES.MEDIA_BUYER ? { buyerId: auth.userId } : {},
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, status: true, channelId: true, buyerId: true, orgId: true, budgetMode: true, dailyBudgetCents: true },
    });
    if (campaigns.length === 0) return [];

    const ids = campaigns.map((c) => c.id);
    const where = dayWhere(range, ids);
    const buyerIds = [...new Set(campaigns.map((c) => c.buyerId))];
    const orgIds = [...new Set(campaigns.map((c) => c.orgId))];

    const [statsByCamp, revByCamp, adSets, channels, buyers, orgs] = await Promise.all([
      tx.adStatsDaily.groupBy({
        by: ['campaignId'],
        where,
        _sum: { spendUsdMinor: true, impressions: true, clicks: true, conversions: true },
      }),
      tx.adRevenueDaily.groupBy({ by: ['campaignId'], where, _sum: { visibleUsdMinor: true } }),
      tx.adSet.findMany({
        where: { campaignId: { in: ids } },
        select: { campaignId: true, dailyBudgetCents: true, _count: { select: { ads: true } } },
      }),
      (() => {
        const refs = campaigns.map((c) => c.channelId).filter((x): x is string => Boolean(x));
        return refs.length
          ? tx.channel.findMany({ where: { id: { in: refs } }, select: { id: true, label: true, channelId: true } })
          : Promise.resolve([] as { id: string; label: string | null; channelId: string }[]);
      })(),
      tx.user.findMany({ where: { id: { in: buyerIds } }, select: { id: true, name: true } }),
      tx.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }),
    ]);

    const statsMap = new Map(statsByCamp.map((r) => [r.campaignId, r._sum]));
    const revMap = new Map(revByCamp.map((r) => [r.campaignId, r._sum.visibleUsdMinor ?? 0]));
    const buyerName = new Map(buyers.map((b) => [b.id, b.name]));
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const adSetCount = new Map<string, number>();
    const adCount = new Map<string, number>();
    const adSetBudget = new Map<string, number>(); // ABO: sum of ad-set daily budgets (cents)
    for (const s of adSets) {
      adSetCount.set(s.campaignId, (adSetCount.get(s.campaignId) ?? 0) + 1);
      adCount.set(s.campaignId, (adCount.get(s.campaignId) ?? 0) + s._count.ads);
      if (s.dailyBudgetCents != null) adSetBudget.set(s.campaignId, (adSetBudget.get(s.campaignId) ?? 0) + s.dailyBudgetCents);
    }
    const channelLabel = new Map(channels.map((c) => [c.id, c.label ?? c.channelId]));

    return campaigns.map((c): CampaignPerf => {
      const s = statsMap.get(c.id);
      const spendUsd = round2(centsToDollars(s?.spendUsdMinor ?? 0));
      const revenueUsd = round2(centsToDollars(revMap.get(c.id) ?? 0));
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        channelLabel: c.channelId ? (channelLabel.get(c.channelId) ?? null) : null,
        buyerId: c.buyerId,
        buyerName: buyerName.get(c.buyerId) ?? '—',
        orgId: c.orgId,
        companyName: orgName.get(c.orgId) ?? '—',
        spendUsd,
        revenueUsd,
        profitUsd: round2(revenueUsd - spendUsd),
        roi: roiOf(revenueUsd, spendUsd),
        impressions: s?.impressions ?? 0,
        clicks: s?.clicks ?? 0,
        conversions: s?.conversions ?? 0,
        adSetCount: adSetCount.get(c.id) ?? 0,
        adCount: adCount.get(c.id) ?? 0,
        budgetMode: c.budgetMode,
        dailyBudgetCents: c.budgetMode === 'CAMPAIGN' ? c.dailyBudgetCents : (adSetBudget.get(c.id) ?? null),
      };
    });
  });
}

/** Ad-set → ad performance breakdown for one campaign (404 if out of scope). */
/**
 * On-demand FB→DB status refresh ("Sync from Facebook"). Enqueues a SCOPED reconcile for the
 * requester's launched (ACTIVE/PAUSED) campaigns so a buyer can pull the latest Facebook status
 * (campaign + ad set + ad) without waiting for the 30-min poll. Reuses the worker reconcile job
 * (one source of truth); RLS via runScoped means a buyer only ever syncs their own campaigns.
 */
export async function requestCampaignStatusSync(auth: AuthContext): Promise<{ campaigns: number }> {
  const ids = await runScoped(auth, (tx) =>
    tx.campaign.findMany({
      where: { status: { in: [CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED] }, fbCampaignId: { not: null } },
      select: { id: true },
    }),
  );
  const campaignIds = ids.map((c) => c.id);
  if (campaignIds.length > 0) {
    await getQueue(QUEUES.META_REJECTION_CHECK).add('sync', { campaignIds }, { removeOnComplete: 50, removeOnFail: 50 });
  }
  return { campaigns: campaignIds.length };
}

export async function getCampaignBreakdown(
  auth: AuthContext,
  campaignId: string,
  range: DateRange,
): Promise<CampaignBreakdown> {
  return runScoped(auth, async (tx) => {
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        name: true,
        status: true,
        buyerId: true,
        budgetMode: true,
        adSets: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            effectiveStatus: true,
            dailyBudgetCents: true,
            fbAdSetId: true,
            ads: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true, effectiveStatus: true } },
          },
        },
      },
    });
    if (!campaign || (auth.role === ROLES.MEDIA_BUYER && campaign.buyerId !== auth.userId)) {
      throw new AppError(404, 'Campaign not found');
    }

    const adIds = campaign.adSets.flatMap((s) => s.ads.map((a) => a.id));
    const where = { day: { gte: range.from, lte: range.to }, adId: { in: adIds } };

    const [statsByAd, revRows] = adIds.length
      ? await Promise.all([
          tx.adStatsDaily.groupBy({
            by: ['adId'],
            where,
            _sum: { spendUsdMinor: true, impressions: true, clicks: true, conversions: true },
          }),
          tx.adRevenueDaily.findMany({
            where,
            orderBy: { day: 'asc' },
            select: { adId: true, visibleUsdMinor: true, basis: true },
          }),
        ])
      : [[], []];

    const statsMap = new Map(statsByAd.map((r) => [r.adId, r._sum]));
    const revByAd = new Map<string, number>();
    const basisByAd = new Map<string, string>();
    for (const r of revRows) {
      revByAd.set(r.adId, (revByAd.get(r.adId) ?? 0) + r.visibleUsdMinor);
      basisByAd.set(r.adId, r.basis); // ordered by day asc → ends on latest day's basis
    }

    let tSpend = 0;
    let tRevenue = 0;
    let tImpr = 0;
    let tClicks = 0;
    let tConv = 0;

    const adSets: AdSetPerf[] = campaign.adSets.map((set) => {
      const ads = set.ads.map((ad): AdPerf => {
        const s = statsMap.get(ad.id);
        const spendUsd = round2(centsToDollars(s?.spendUsdMinor ?? 0));
        const revenueUsd = round2(centsToDollars(revByAd.get(ad.id) ?? 0));
        tSpend += spendUsd;
        tRevenue += revenueUsd;
        tImpr += s?.impressions ?? 0;
        tClicks += s?.clicks ?? 0;
        tConv += s?.conversions ?? 0;
        return {
          id: ad.id,
          name: ad.name,
          effectiveStatus: ad.effectiveStatus,
          spendUsd,
          revenueUsd,
          profitUsd: round2(revenueUsd - spendUsd),
          roi: roiOf(revenueUsd, spendUsd),
          impressions: s?.impressions ?? 0,
          clicks: s?.clicks ?? 0,
          conversions: s?.conversions ?? 0,
          basis: basisByAd.get(ad.id) ?? null,
        };
      });
      // Roll the ads up to the ad-set level so the tree has numbers at every level.
      const setSpend = round2(ads.reduce((a, x) => a + x.spendUsd, 0));
      const setRev = round2(ads.reduce((a, x) => a + x.revenueUsd, 0));
      return {
        id: set.id,
        name: set.name,
        effectiveStatus: set.effectiveStatus,
        spendUsd: setSpend,
        revenueUsd: setRev,
        profitUsd: round2(setRev - setSpend),
        roi: roiOf(setRev, setSpend),
        impressions: ads.reduce((a, x) => a + x.impressions, 0),
        clicks: ads.reduce((a, x) => a + x.clicks, 0),
        conversions: ads.reduce((a, x) => a + x.conversions, 0),
        dailyBudgetCents: set.dailyBudgetCents,
        // Editable only for a live ABO campaign whose ad set is on Facebook (mirrors updateAdSetBudget).
        editableBudget:
          (campaign.status === 'ACTIVE' || campaign.status === 'PAUSED') && campaign.budgetMode === 'AD_SET' && set.fbAdSetId != null,
        ads,
      };
    });

    const totals: MetricTotals = {
      spendUsd: round2(tSpend),
      revenueUsd: round2(tRevenue),
      profitUsd: round2(tRevenue - tSpend),
      roi: roiOf(tRevenue, tSpend),
      impressions: tImpr,
      clicks: tClicks,
      conversions: tConv,
      marginUsd: 0,
    };

    return {
      range,
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
      totals,
      adSets,
    };
  });
}

/**
 * Per-dimension (country / hour) breakdown for one campaign over a range. Cost +
 * the conversion signal come from `ad_stats_dim_daily` (FB breakdown insights);
 * revenue is allocated from the campaign's total over the range by conversion
 * share (→ clicks → impressions), the same D8 principle as the ad-level split,
 * since AFS revenue has no geo/hour dimension. 404 if out of scope; [] if no data.
 */
export async function getCampaignDimBreakdown(
  auth: AuthContext,
  campaignId: string,
  range: DateRange,
  dim: StatDim,
): Promise<DimStat[]> {
  return runScoped(auth, async (tx) => {
    const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, select: { id: true, buyerId: true } });
    if (!campaign || (auth.role === ROLES.MEDIA_BUYER && campaign.buyerId !== auth.userId)) {
      throw new AppError(404, 'Campaign not found');
    }
    const where = { campaignId, dim, day: { gte: range.from, lte: range.to } };
    const grouped = await tx.adStatDimDaily.groupBy({
      by: ['dimValue'],
      where,
      _sum: { spendUsdMinor: true, impressions: true, clicks: true, conversions: true },
    });
    if (grouped.length === 0) return [];

    const rev = await tx.adRevenueDaily.aggregate({
      where: { campaignId, day: { gte: range.from, lte: range.to } },
      _sum: { visibleUsdMinor: true },
    });
    const grossCents = rev._sum.visibleUsdMinor ?? 0;

    const convs = grouped.map((g) => g._sum.conversions ?? 0);
    const clicks = grouped.map((g) => g._sum.clicks ?? 0);
    const imps = grouped.map((g) => g._sum.impressions ?? 0);
    const weights = convs.some((c) => c > 0) ? convs : clicks.some((c) => c > 0) ? clicks : imps;
    const alloc = allocateByWeights(grossCents, weights);

    return grouped
      .map((g, i): DimStat => {
        const spendUsd = round2(centsToDollars(g._sum.spendUsdMinor ?? 0));
        const revenueUsd = round2(centsToDollars(alloc[i] ?? 0));
        return {
          dimValue: g.dimValue,
          spendUsd,
          revenueUsd,
          profitUsd: round2(revenueUsd - spendUsd),
          roi: roiOf(revenueUsd, spendUsd),
          impressions: imps[i] ?? 0,
          clicks: clicks[i] ?? 0,
          conversions: convs[i] ?? 0,
        };
      })
      .sort((a, b) => b.spendUsd - a.spendUsd);
  });
}

/** Effective platform cut for a campaign's buyer (buyer override ?? org default). */
async function offerCutPct(tx: TxClient, orgId: string, buyerId: string): Promise<number> {
  const [org, buyer] = await Promise.all([
    tx.organization.findUnique({ where: { id: orgId }, select: { defaultRevenueCutPct: true } }),
    tx.user.findUnique({ where: { id: buyerId }, select: { revenueCutPct: true } }),
  ]);
  return Number(buyer?.revenueCutPct ?? org?.defaultRevenueCutPct ?? 0);
}

/**
 * Per-offer revenue for one campaign over the range (Phase F). Each offer's gross AFS
 * channel revenue (offer_revenue_daily) summed, then the platform cut applied → the
 * buyer-visible amount; suppressed (hidden) when AFS clicks are below the threshold.
 * Lets the buyer see WHICH website/offer monetizes best (cost stays campaign-level).
 * Owner/admin scoped (RLS + a buyer can only see their own campaign).
 */
export async function getCampaignOfferStats(
  auth: AuthContext,
  campaignId: string,
  range: DateRange,
): Promise<OfferStat[]> {
  return runScoped(auth, async (tx) => {
    const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, select: { buyerId: true, orgId: true } });
    if (!campaign) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && campaign.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');

    const offers = await tx.offer.findMany({
      where: { campaignId },
      include: { domain: { select: { host: true, afsAccount: { select: { label: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    if (offers.length === 0) return [];

    const rev = await tx.offerRevenueDaily.groupBy({
      by: ['offerId'],
      where: { offerId: { in: offers.map((o) => o.id) }, day: { gte: range.from, lte: range.to } },
      _sum: { revenueUsdMinor: true, afsClicks: true },
    });
    const byOffer = new Map(rev.map((r) => [r.offerId, r]));
    const cut = await offerCutPct(tx, campaign.orgId, campaign.buyerId);

    return offers.map((o): OfferStat => {
      const r = byOffer.get(o.id);
      const grossMinor = r?._sum.revenueUsdMinor ?? 0;
      const afsClicks = r?._sum.afsClicks ?? 0;
      // Google's AFS rule (support.google.com/adsense/answer/10078316): below 10 clicks/day it masks
      // CLICK-DERIVED metrics (clicks, CTR, CPC) to 0 — but NOT estimated earnings. So we ALWAYS show
      // the revenue (even $0.01 if the channel earned it); `suppressed` now flags only that the
      // click-derived columns are hidden, never the earnings.
      const suppressed = afsClicks < AFS_CLICK_SUPPRESSION_THRESHOLD;
      const visibleMinor = Math.round(grossMinor * (1 - cut));
      return {
        offerId: o.id,
        host: o.domain.host,
        afsLabel: o.domain.afsAccount.label,
        kind: o.kind,
        weightPct: o.weightPct,
        revenueUsd: round2(centsToDollars(visibleMinor)), // earnings always shown (Google doesn't mask earnings)
        afsClicks,
        suppressed, // click-derived metrics (clicks / CPC) hidden below 10 clicks/day — revenue is NOT
      };
    });
  });
}

/**
 * Per-buyer rollup (company-admin: own org via RLS; super-admin: all buyers).
 * Aggregates each buyer's campaigns' spend/revenue/margin over the range.
 */
export async function getBuyerRollup(auth: AuthContext, range: DateRange): Promise<BuyerRollup[]> {
  return runScoped(auth, async (tx) => {
    const buyers = await tx.user.findMany({
      where: { role: ROLES.MEDIA_BUYER },
      select: { id: true, name: true, email: true },
    });
    if (buyers.length === 0) return [];
    const campaigns = await tx.campaign.findMany({ select: { id: true, buyerId: true } });
    const campToBuyer = new Map(campaigns.map((c) => [c.id, c.buyerId]));
    const campCount = new Map<string, number>();
    for (const c of campaigns) campCount.set(c.buyerId, (campCount.get(c.buyerId) ?? 0) + 1);

    const where = { day: { gte: range.from, lte: range.to }, campaignId: { in: campaigns.map((c) => c.id) } };
    const [statsByCamp, revByCamp] = await Promise.all([
      tx.adStatsDaily.groupBy({ by: ['campaignId'], where, _sum: { spendUsdMinor: true } }),
      tx.adRevenueDaily.groupBy({ by: ['campaignId'], where, _sum: { visibleUsdMinor: true, marginUsdMinor: true } }),
    ]);
    const spend = new Map<string, number>();
    const revenue = new Map<string, number>();
    const margin = new Map<string, number>();
    for (const r of statsByCamp) {
      const b = campToBuyer.get(r.campaignId);
      if (b) spend.set(b, (spend.get(b) ?? 0) + (r._sum.spendUsdMinor ?? 0));
    }
    for (const r of revByCamp) {
      const b = campToBuyer.get(r.campaignId);
      if (!b) continue;
      revenue.set(b, (revenue.get(b) ?? 0) + (r._sum.visibleUsdMinor ?? 0));
      margin.set(b, (margin.get(b) ?? 0) + (r._sum.marginUsdMinor ?? 0));
    }
    return buyers
      .map((b): BuyerRollup => {
        const spendUsd = round2(centsToDollars(spend.get(b.id) ?? 0));
        const revenueUsd = round2(centsToDollars(revenue.get(b.id) ?? 0));
        return {
          buyerId: b.id,
          name: b.name,
          email: b.email,
          spendUsd,
          revenueUsd,
          profitUsd: round2(revenueUsd - spendUsd),
          marginUsd: round2(centsToDollars(margin.get(b.id) ?? 0)),
          campaignCount: campCount.get(b.id) ?? 0,
        };
      })
      .sort((a, b) => b.revenueUsd - a.revenueUsd);
  });
}

/**
 * Per-company rollup (SUPER_ADMIN only — guarded at the route). Groups the daily
 * tables by orgId directly (they carry org_id), so it's a cheap platform-wide scan.
 */
export async function getCompanyRollup(auth: AuthContext, range: DateRange): Promise<CompanyRollup[]> {
  return runScoped(auth, async (tx) => {
    // Exclude the platform org (KNN staff) — it's not a client company, mirroring
    // the Companies list (listOrganizations).
    const orgs = await tx.organization.findMany({
      where: { isPlatform: false },
      select: { id: true, name: true, defaultRevenueCutPct: true },
    });
    const where = { day: { gte: range.from, lte: range.to } };
    const [statsByOrg, revByOrg, buyerCounts, campCounts] = await Promise.all([
      tx.adStatsDaily.groupBy({ by: ['orgId'], where, _sum: { spendUsdMinor: true } }),
      tx.adRevenueDaily.groupBy({ by: ['orgId'], where, _sum: { visibleUsdMinor: true, marginUsdMinor: true } }),
      tx.user.groupBy({ by: ['orgId'], where: { role: ROLES.MEDIA_BUYER }, _count: { _all: true } }),
      tx.campaign.groupBy({ by: ['orgId'], _count: { _all: true } }),
    ]);
    const spend = new Map(statsByOrg.map((r) => [r.orgId, r._sum.spendUsdMinor ?? 0]));
    const rev = new Map(revByOrg.map((r) => [r.orgId, r._sum.visibleUsdMinor ?? 0]));
    const margin = new Map(revByOrg.map((r) => [r.orgId, r._sum.marginUsdMinor ?? 0]));
    const buyers = new Map(buyerCounts.map((r) => [r.orgId, r._count._all]));
    const camps = new Map(campCounts.map((r) => [r.orgId, r._count._all]));
    return orgs
      .map((o): CompanyRollup => ({
        orgId: o.id,
        name: o.name,
        spendUsd: round2(centsToDollars(spend.get(o.id) ?? 0)),
        revenueUsd: round2(centsToDollars(rev.get(o.id) ?? 0)),
        marginUsd: round2(centsToDollars(margin.get(o.id) ?? 0)),
        buyerCount: buyers.get(o.id) ?? 0,
        campaignCount: camps.get(o.id) ?? 0,
        defaultRevenueCutPct: Number(o.defaultRevenueCutPct),
      }))
      .sort((a, b) => b.revenueUsd - a.revenueUsd);
  });
}
