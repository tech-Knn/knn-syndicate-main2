import { type TxClient } from '@knn/db';
import {
  FUNNEL_EVENT_NAME,
  type FunnelCounts,
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
  SYNC_INTERVALS_SEC,
  SYNC_STATE_KEYS,
  addBusinessDays,
  allocateByWeights,
  businessDayBoundsUtc,
  businessDaysInRange,
  centsToDollars,
  currentBusinessDay,
  rpcPerAdClick,
} from '@knn/shared';
import { QUEUES, getQueue } from '@knn/queue';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { type EventSource, creditToOffers } from './offer-funnel.js';

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

/**
 * The range as UTC instants [start, end) — for raw events (not daily rollups), bucketed by the IST
 * business day like everything else. `conversion_events.created_at` is the moment the beacon landed,
 * i.e. the ad click (and it's the indexed column).
 */
function rangeBoundsUtc(range: DateRange): { start: Date; end: Date } {
  return { start: businessDayBoundsUtc(range.from).start, end: businessDayBoundsUtc(range.to).end };
}

/** Our funnel events (D30) → the FunnelCounts field each one counts toward. */
const FUNNEL_FIELD: Readonly<Record<string, keyof FunnelCounts>> = {
  [FUNNEL_EVENT_NAME.lander]: 'visits',
  [FUNNEL_EVENT_NAME.search]: 'keywordClicks',
  [FUNNEL_EVENT_NAME.adclick]: 'adClicks',
};
const FUNNEL_EVENTS = Object.keys(FUNNEL_FIELD);
const NO_FUNNEL: FunnelCounts = { visits: 0, keywordClicks: 0, adClicks: 0 };

/** Fold grouped (key, event) counts into FunnelCounts per key. */
function foldFunnel(rows: readonly { key: string; eventName: string; count: number }[]): Map<string, FunnelCounts> {
  const out = new Map<string, FunnelCounts>();
  for (const r of rows) {
    const field = FUNNEL_FIELD[r.eventName];
    if (!field) continue;
    const f = out.get(r.key) ?? { ...NO_FUNNEL };
    f[field] += r.count;
    out.set(r.key, f);
  }
  return out;
}

function sumFunnel(items: readonly FunnelCounts[]): FunnelCounts {
  return items.reduce((t, f) => ({ visits: t.visits + f.visits, keywordClicks: t.keywordClicks + f.keywordClicks, adClicks: t.adClicks + f.adClicks }), { ...NO_FUNNEL });
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
      select: { id: true, name: true, status: true, adProvider: true, channelId: true, buyerId: true, orgId: true, budgetMode: true, dailyBudgetCents: true },
    });
    if (campaigns.length === 0) return [];

    const ids = campaigns.map((c) => c.id);
    const where = dayWhere(range, ids);
    const buyerIds = [...new Set(campaigns.map((c) => c.buyerId))];
    const orgIds = [...new Set(campaigns.map((c) => c.orgId))];

    const { start, end } = rangeBoundsUtc(range);
    const [statsByCamp, revByCamp, adSets, channels, buyers, orgs, funnelRows] = await Promise.all([
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
      // Our own funnel tracking (D30) — visits, keyword clicks, ad clicks; live, never hidden.
      tx.conversionEvent.groupBy({
        by: ['campaignId', 'eventName'],
        where: { campaignId: { in: ids }, eventName: { in: FUNNEL_EVENTS }, createdAt: { gte: start, lt: end } },
        _count: { _all: true },
      }),
    ]);

    const statsMap = new Map(statsByCamp.map((r) => [r.campaignId, r._sum]));
    const funnelByCamp = foldFunnel(funnelRows.map((r) => ({ key: r.campaignId, eventName: r.eventName, count: r._count._all })));
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
        adProvider: c.adProvider,
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
        ...(funnelByCamp.get(c.id) ?? NO_FUNNEL),
      };
    });
  });
}

/** Ad-set → ad performance breakdown for one campaign (404 if out of scope). */
export interface SyncFreshness {
  /** FB campaign/ad-set/ad status reconcile. */
  fbStatus: { at: string | null; everySec: number };
  /** Spend/revenue (FB insights + AdSense) attribution. */
  metrics: { at: string | null; everySec: number };
}

/**
 * Freshness of the scheduled syncs, for the Analytics "auto-updates • last updated X ago" indicator.
 * There is deliberately NO manual refresh: Meta's per-ad-account BUC limits and AdSense's
 * project-wide 500/min + 10k/day caps make on-demand fan-out unsafe across many buyers, and the
 * platforms' own reporting only refreshes every ~15 min anyway. Data lands on the worker crons
 * (status every 30 min, metrics hourly); this reports WHEN each last completed.
 */
/**
 * SUPER_ADMIN ops: enqueue an immediate global FB→DB reconcile — the SAME job the 30-min cron
 * runs — to force a status refresh on demand (debugging / "I just changed things in Ads Manager").
 * NOT buyer-facing: there's no per-buyer fan-out, so it doesn't reintroduce the rate-limit risk of
 * a buyer refresh button; the scheduled cron remains the normal path.
 */
export async function triggerCampaignReconcile(): Promise<{ enqueued: true }> {
  await getQueue(QUEUES.META_REJECTION_CHECK).add('admin-reconcile', {}, { removeOnComplete: 50, removeOnFail: 50 });
  return { enqueued: true };
}

export async function getSyncStatus(auth: AuthContext): Promise<SyncFreshness> {
  const rows = await runScoped(auth, (tx) =>
    tx.platformSetting.findMany({
      where: { key: { in: [SYNC_STATE_KEYS.FB_STATUS, SYNC_STATE_KEYS.METRICS] } },
      select: { key: true, value: true },
    }),
  );
  const at = (key: string): string | null => rows.find((r) => r.key === key)?.value ?? null;
  return {
    fbStatus: { at: at(SYNC_STATE_KEYS.FB_STATUS), everySec: SYNC_INTERVALS_SEC.FB_STATUS },
    metrics: { at: at(SYNC_STATE_KEYS.METRICS), everySec: SYNC_INTERVALS_SEC.METRICS },
  };
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
        adProvider: true,
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
            whopAdGroupId: true,
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
    const { start, end } = rangeBoundsUtc(range);

    const [statsByAd, revRows, funnelRows] = await Promise.all([
      adIds.length
        ? tx.adStatsDaily.groupBy({
            by: ['adId'],
            where,
            _sum: { spendUsdMinor: true, impressions: true, clicks: true, conversions: true },
          })
        : Promise.resolve([]),
      adIds.length
        ? tx.adRevenueDaily.findMany({
            where,
            orderBy: { day: 'asc' },
            select: { adId: true, visibleUsdMinor: true, basis: true },
          })
        : Promise.resolve([]),
      // Per ad — exact, since each tracked event carries the ad its click came from (D30).
      tx.conversionEvent.groupBy({
        by: ['adId', 'eventName'],
        where: { campaignId, eventName: { in: FUNNEL_EVENTS }, createdAt: { gte: start, lt: end } },
        _count: { _all: true },
      }),
    ]);

    const statsMap = new Map(statsByAd.map((r) => [r.adId, r._sum]));
    const funnelByAd = foldFunnel(funnelRows.map((r) => ({ key: r.adId, eventName: r.eventName, count: r._count._all })));
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
          ...(funnelByAd.get(ad.id) ?? NO_FUNNEL),
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
        ...sumFunnel(ads),
        dailyBudgetCents: set.dailyBudgetCents,
        // Editable only for a live ABO campaign whose ad set is at its ad network, Facebook or Whop (mirrors updateAdSetBudget).
        editableBudget:
          (campaign.status === 'ACTIVE' || campaign.status === 'PAUSED') && campaign.budgetMode === 'AD_SET' && (set.fbAdSetId ?? set.whopAdGroupId) != null,
        ads,
      };
    });

    const totals: MetricTotals & FunnelCounts = {
      spendUsd: round2(tSpend),
      revenueUsd: round2(tRevenue),
      profitUsd: round2(tRevenue - tSpend),
      roi: roiOf(tRevenue, tSpend),
      impressions: tImpr,
      clicks: tClicks,
      conversions: tConv,
      marginUsd: 0,
      // Every tracked event of the campaign — so the total matches the Analytics row even if an
      // event's ad is no longer in the tree.
      ...sumFunnel([...funnelByAd.values()]),
    };

    return {
      range,
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status, adProvider: campaign.adProvider },
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
 * Per-offer (website) results for one campaign over the range (Phase F): each offer's AdSense channel
 * revenue (offer_revenue_daily) with the platform cut applied — always shown, Google never hides
 * earnings — plus our funnel counts on that website (visits, keyword clicks, ad clicks) and the RPC
 * they give (D30). Lets the buyer see WHICH website monetizes best (cost stays campaign-level).
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

    const { start, end } = rangeBoundsUtc(range);
    const [rev, cut, sources] = await Promise.all([
      // By channel too: a shared-host tie-break needs every channel an offer rolled over through.
      tx.offerRevenueDaily.groupBy({
        by: ['offerId', 'channelRef'],
        where: { offerId: { in: offers.map((o) => o.id) }, day: { gte: range.from, lte: range.to } },
        _sum: { revenueUsdMinor: true },
      }),
      offerCutPct(tx, campaign.orgId, campaign.buyerId),
      // Each tracked funnel event's website host + AFS channel (the `#c=` results-page URLs carry).
      tx.$queryRaw<(EventSource & { eventName: string })[]>`
        SELECT lower(substring(event_source_url from '^https?://([^/:?#]+)')) AS host,
               substring(event_source_url from '#(?:.*&)?c=([^&]*)') AS channel,
               event_name AS "eventName",
               count(*)::int AS count
        FROM conversion_events
        WHERE campaign_id = ${campaignId}::uuid
          AND event_name = ANY(${FUNNEL_EVENTS}::text[])
          AND created_at >= (${start.toISOString()}::timestamptz AT TIME ZONE 'UTC')
          AND created_at < (${end.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY 1, 2, 3`,
    ]);

    const grossByOffer = new Map<string, number>();
    const channelRefsByOffer = new Map(offers.map((o) => [o.id, new Set(o.channelRef ? [o.channelRef] : [])]));
    for (const r of rev) {
      grossByOffer.set(r.offerId, (grossByOffer.get(r.offerId) ?? 0) + (r._sum.revenueUsdMinor ?? 0));
      channelRefsByOffer.get(r.offerId)?.add(r.channelRef);
    }
    // Channel ids only matter when two offers share a host — look them up only then.
    const hosts = offers.map((o) => o.domain.host.toLowerCase());
    const sharedHost = new Set(hosts).size < hosts.length;
    const channelIdByRef = new Map<string, string>();
    if (sharedHost) {
      const refs = [...new Set([...channelRefsByOffer.values()].flatMap((s) => [...s]))];
      for (const c of await tx.channel.findMany({ where: { id: { in: refs } }, select: { id: true, channelId: true } })) {
        channelIdByRef.set(c.id, c.channelId);
      }
    }
    const offersForCredit = offers.map((o) => ({
      id: o.id,
      host: o.domain.host,
      weightPct: o.weightPct,
      channelIds: [...(channelRefsByOffer.get(o.id) ?? [])].map((ref) => channelIdByRef.get(ref)).filter((x): x is string => Boolean(x)),
    }));
    const sourcesByField: Record<keyof FunnelCounts, EventSource[]> = { visits: [], keywordClicks: [], adClicks: [] };
    for (const s of sources) {
      const field = FUNNEL_FIELD[s.eventName];
      if (field) sourcesByField[field].push({ host: s.host, channel: s.channel === null ? null : safeDecode(s.channel), count: s.count });
    }
    const credited = {
      visits: creditToOffers(sourcesByField.visits, offersForCredit),
      keywordClicks: creditToOffers(sourcesByField.keywordClicks, offersForCredit),
      adClicks: creditToOffers(sourcesByField.adClicks, offersForCredit),
    };

    return offers.map((o): OfferStat => {
      const revenueUsd = round2(centsToDollars(Math.round((grossByOffer.get(o.id) ?? 0) * (1 - cut))));
      const adClicks = credited.adClicks.get(o.id) ?? 0;
      const rpc = rpcPerAdClick(revenueUsd, adClicks);
      return {
        offerId: o.id,
        host: o.domain.host,
        // The platform's own name for its Google account: a buyer or a company admin never needs it.
        afsLabel: auth.role === ROLES.SUPER_ADMIN ? o.domain.afsAccount.label : null,
        kind: o.kind,
        weightPct: o.weightPct,
        revenueUsd,
        visits: credited.visits.get(o.id) ?? 0,
        keywordClicks: credited.keywordClicks.get(o.id) ?? 0,
        adClicks,
        rpcUsd: rpc === null ? null : Math.round(rpc * 10000) / 10000,
      };
    });
  });
}

/** URL-decode a query value, keeping it as-is if it isn't valid encoding. */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
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
