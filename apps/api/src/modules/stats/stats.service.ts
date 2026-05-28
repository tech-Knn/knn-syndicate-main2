import { type TxClient } from '@knn/db';
import {
  type AdPerf,
  type AdSetPerf,
  type BuyerRollup,
  type CampaignBreakdown,
  type CampaignPerf,
  type CompanyRollup,
  type DailyPoint,
  type DateRange,
  type MetricTotals,
  ROLES,
  type StatsSummary,
  addBusinessDays,
  businessDaysInRange,
  centsToDollars,
  currentBusinessDay,
} from '@knn/shared';
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
  return spendUsd > 0 ? Math.round((revenueUsd / spendUsd) * 10000) / 10000 : 0;
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
      select: { id: true, name: true, status: true, channelId: true },
    });
    if (campaigns.length === 0) return [];

    const ids = campaigns.map((c) => c.id);
    const where = dayWhere(range, ids);

    const [statsByCamp, revByCamp, adSets, channels] = await Promise.all([
      tx.adStatsDaily.groupBy({
        by: ['campaignId'],
        where,
        _sum: { spendUsdMinor: true, impressions: true, clicks: true, conversions: true },
      }),
      tx.adRevenueDaily.groupBy({ by: ['campaignId'], where, _sum: { visibleUsdMinor: true } }),
      tx.adSet.findMany({
        where: { campaignId: { in: ids } },
        select: { campaignId: true, _count: { select: { ads: true } } },
      }),
      (() => {
        const refs = campaigns.map((c) => c.channelId).filter((x): x is string => Boolean(x));
        return refs.length
          ? tx.channel.findMany({ where: { id: { in: refs } }, select: { id: true, label: true, channelId: true } })
          : Promise.resolve([] as { id: string; label: string | null; channelId: string }[]);
      })(),
    ]);

    const statsMap = new Map(statsByCamp.map((r) => [r.campaignId, r._sum]));
    const revMap = new Map(revByCamp.map((r) => [r.campaignId, r._sum.visibleUsdMinor ?? 0]));
    const adSetCount = new Map<string, number>();
    const adCount = new Map<string, number>();
    for (const s of adSets) {
      adSetCount.set(s.campaignId, (adSetCount.get(s.campaignId) ?? 0) + 1);
      adCount.set(s.campaignId, (adCount.get(s.campaignId) ?? 0) + s._count.ads);
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
        spendUsd,
        revenueUsd,
        profitUsd: round2(revenueUsd - spendUsd),
        roi: roiOf(revenueUsd, spendUsd),
        impressions: s?.impressions ?? 0,
        clicks: s?.clicks ?? 0,
        conversions: s?.conversions ?? 0,
        adSetCount: adSetCount.get(c.id) ?? 0,
        adCount: adCount.get(c.id) ?? 0,
      };
    });
  });
}

/** Ad-set → ad performance breakdown for one campaign (404 if out of scope). */
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
        adSets: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, ads: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true } } },
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

    const adSets: AdSetPerf[] = campaign.adSets.map((set) => ({
      id: set.id,
      name: set.name,
      ads: set.ads.map((ad): AdPerf => {
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
          spendUsd,
          revenueUsd,
          profitUsd: round2(revenueUsd - spendUsd),
          roi: roiOf(revenueUsd, spendUsd),
          impressions: s?.impressions ?? 0,
          clicks: s?.clicks ?? 0,
          conversions: s?.conversions ?? 0,
          basis: basisByAd.get(ad.id) ?? null,
        };
      }),
    }));

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
    const orgs = await tx.organization.findMany({ select: { id: true, name: true, defaultRevenueCutPct: true } });
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
