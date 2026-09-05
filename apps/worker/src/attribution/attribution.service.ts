import { type TxClient, withSystem } from '@knn/db';
import type { ChannelDayRevenue } from '@knn/adsense';
import { type FbAdInsightRow, FbConnectionBrokenError, fetchAdInsights } from '@knn/fb';
import { markConnectionBroken, resolveCampaignReadAuth } from '../lib/fb-read-auth.js';
import {
  AFS_CLICK_SUPPRESSION_THRESHOLD,
  type AdSignals,
  FINALIZATION,
  allocateCampaignRevenue,
  applyRevenueCut,
  businessDay,
  toUsdMinor,
  zonedStartOfDayUtc,
} from '@knn/shared';
import { liveAdsenseFetch } from './adsense-source.js';
import { ensureFxRatesForDays, getUsdRate } from './fx.service.js';

/**
 * Revenue attribution (Phase 9, D8/D15). Two pulls feed three daily tables:
 *  1. FB insights per ad → `ad_stats_daily` (cost + the conversion signal).
 *  2. AdSense revenue per channel → `campaign_revenue_daily` (the AFS gross),
 *     mapped to the campaign that held the channel that IST day.
 *  3. allocate: split each campaign's gross USD across its ads by conversion share
 *     (D8) with the zero-conversion fallback (clicks→impressions→unallocated), then
 *     apply the platform revenue cut → `ad_revenue_daily`.
 * Everything runs under `withSystem` (cross-org; rows carry org_id). Every write is an
 * upsert keyed on (entity, day), so re-pulls in the finalization window are idempotent
 * (no double counting) — the basis of the §5.8 data-finalization re-pulls.
 */

export interface AttributionDeps {
  fetchInsights: typeof fetchAdInsights;
  /** AFS revenue source — channels grouped by AFS account (Phase F multi-account). Dormant
   *  by default until a SUPER_ADMIN connects AdSense (AFS API access is OPEN_QUESTIONS #4). */
  fetchAdsense?: (params: {
    since: string;
    until: string;
    accounts: { afsAccountId: string; channelIds: string[] }[];
  }) => Promise<ChannelDayRevenue[]>;
  getRate: (tx: TxClient, day: string, currency: string) => Promise<number>;
  /** Refresh FX rates for the days before pulling (best-effort; omitted in tests). */
  ensureFx?: (days: string[]) => Promise<void>;
}

const defaultDeps: AttributionDeps = {
  fetchInsights: fetchAdInsights,
  // Live AFS source: a no-op until a SUPER_ADMIN connects AdSense (and AFS access lands),
  // so production auto-activates while tests/dormant deployments stay revenue-empty.
  fetchAdsense: liveAdsenseFetch,
  getRate: getUsdRate,
  ensureFx: ensureFxRatesForDays,
};

/** Last `count` calendar-day strings (YYYY-MM-DD) ending at and including `endDay`. */
export function recentDays(endDay: string, count: number): string[] {
  const endMs = Date.parse(`${endDay}T00:00:00Z`);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(new Date(endMs - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

// ── 1. Facebook insights → ad_stats_daily ────────────────────────────────────

interface LaunchedCampaign {
  id: string;
  orgId: string;
  buyerId: string;
  fbCampaignId: string;
  fbAccountId: string | null;
  adAccountId: string | null;
}

/** Pull FB insights for one campaign over [since, until] and upsert per-ad daily rows. */
async function pullFbStatsForCampaign(
  campaign: LaunchedCampaign,
  since: string,
  until: string,
  deps: AttributionDeps,
): Promise<number> {
  return withSystem(async (tx) => {
    // Resolve the token by the STABLE Meta fbAccountId against the buyer's CURRENT healthy
    // connection — NOT the campaign's pinned, connection-bound adAccountId, which goes stale
    // after a reconnect/app-switch (the bug behind spend going stale). Reuses this txn, and
    // returns the connection's appKind so appsecret_proof is signed with the right app secret.
    const auth = await resolveCampaignReadAuth({ fbAccountId: campaign.fbAccountId, adAccountId: campaign.adAccountId }, tx);
    if (!auth) return 0;

    const ads = await tx.ad.findMany({
      where: { adSet: { campaignId: campaign.id }, fbAdId: { not: null } },
      select: { id: true, fbAdId: true },
    });
    const adByFbId = new Map(ads.map((a) => [a.fbAdId as string, a.id]));
    if (adByFbId.size === 0) return 0;

    // Every insights call goes through this: a 190 (token dead before its expiry — checkpoint,
    // password change) degrades the CONNECTION so the next campaign in this run, and every other
    // job, stops hitting it. Without this each dead token costs 3 failed calls per campaign per
    // hour against the app-wide Marketing API error-rate quota. Uses its own txn (not `tx`) so
    // the flip commits even if this campaign's stats txn rolls back.
    const fetchOrDegrade = async (params: Parameters<typeof deps.fetchInsights>[0]): Promise<FbAdInsightRow[]> => {
      try {
        return await deps.fetchInsights(params);
      } catch (err) {
        if (err instanceof FbConnectionBrokenError) {
          await markConnectionBroken(auth.connectionId, `attribution: ${err.message}`);
        }
        throw err;
      }
    };

    const rows: FbAdInsightRow[] = await fetchOrDegrade({
      fbCampaignId: campaign.fbCampaignId,
      accountId: auth.fbAccountId,
      accessToken: auth.token,
      appKind: auth.appKind,
      since,
      until,
    });

    let n = 0;
    for (const row of rows) {
      const adId = adByFbId.get(row.fbAdId);
      if (!adId) continue;
      const rate = await deps.getRate(tx, row.day, auth.currency);
      await tx.adStatsDaily.upsert({
        where: { adId_day: { adId, day: row.day } },
        create: {
          orgId: campaign.orgId,
          adId,
          campaignId: campaign.id,
          day: row.day,
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
          spendMinor: row.spendMinor,
          spendUsdMinor: toUsdMinor(row.spendMinor, rate),
          currency: auth.currency,
        },
        update: {
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
          spendMinor: row.spendMinor,
          spendUsdMinor: toUsdMinor(row.spendMinor, rate),
          currency: auth.currency,
        },
      });
      n += 1;
    }

    // Best-effort country + hour breakdowns for the Analytics drill-down. Fully
    // guarded: a breakdown failure (or a test fetcher that ignores `breakdown`)
    // never affects the core cost/revenue attribution above.
    for (const dim of ['country', 'hour'] as const) {
      try {
        const dimRows = await fetchOrDegrade({
          fbCampaignId: campaign.fbCampaignId,
          accountId: auth.fbAccountId,
          accessToken: auth.token,
          appKind: auth.appKind,
          since,
          until,
          breakdown: dim,
        });
        for (const row of dimRows) {
          const adId = adByFbId.get(row.fbAdId);
          if (!adId || !row.dimValue) continue;
          const rate = await deps.getRate(tx, row.day, auth.currency);
          const data = {
            impressions: row.impressions,
            clicks: row.clicks,
            conversions: row.conversions,
            spendMinor: row.spendMinor,
            spendUsdMinor: toUsdMinor(row.spendMinor, rate),
            currency: auth.currency,
          };
          await tx.adStatDimDaily.upsert({
            where: { adId_day_dim_dimValue: { adId, day: row.day, dim, dimValue: row.dimValue } },
            create: { orgId: campaign.orgId, adId, campaignId: campaign.id, day: row.day, dim, dimValue: row.dimValue, ...data },
            update: data,
          });
        }
      } catch (err) {
        console.error(`[attribution] dim '${dim}' pull failed for campaign ${campaign.id}:`, (err as Error).message);
      }
    }
    return n;
  });
}

/** Pull FB insights for every launched campaign over [since, until]. */
export async function pullFbStats(
  since: string,
  until: string,
  deps: AttributionDeps = defaultDeps,
): Promise<{ campaigns: number; rows: number }> {
  const campaigns = await withSystem((tx) =>
    tx.campaign.findMany({
      where: { fbCampaignId: { not: null }, adAccountId: { not: null } },
      select: { id: true, orgId: true, buyerId: true, fbCampaignId: true, fbAccountId: true, adAccountId: true },
    }),
  );
  let rows = 0;
  let touched = 0;
  for (const c of campaigns as LaunchedCampaign[]) {
    try {
      const n = await pullFbStatsForCampaign(c, since, until, deps);
      rows += n;
      if (n > 0) touched += 1;
    } catch (err) {
      console.error(`[attribution] FB stats pull failed for campaign ${c.id}:`, (err as Error).message);
    }
  }
  return { campaigns: touched, rows };
}

// ── 2. AdSense revenue → campaign_revenue_daily ───────────────────────────────

interface CampaignDayRollup {
  orgId: string;
  campaignId: string;
  day: string;
  channelRef: string;
  revenueMinor: number;
  revenueUsdMinor: number;
  afsClicks: number;
  // AFS fill-rate counts (observe-only) — summed across the campaign's channels, like afsClicks.
  afsRequests: number;
  afsMatchedRequests: number;
  afsImpressions: number;
  currencies: Set<string>;
}

/** The "platform" AFS account for legacy global channels (domain_id IS NULL). */
async function defaultAfsAccountId(): Promise<string | null> {
  return withSystem(async (tx) => {
    const platform = await tx.googleConnection.findUnique({ where: { id: 'platform' }, select: { id: true } });
    if (platform) return platform.id;
    const all = await tx.googleConnection.findMany({ select: { id: true }, take: 2 });
    return all.length === 1 ? all[0]!.id : null;
  });
}

/**
 * Pull AFS revenue per channel for [since, until] and record it (Phase F): per-offer in
 * `offer_revenue_daily` (each offer's own channel), and summed into `campaign_revenue_daily`
 * for the campaign that held each channel that day (the attribution span, D7). Channels are
 * grouped by their AFS account (offer channels → the domain's account; legacy global channels
 * → the platform account) so each is pulled with the right token (multi-account). Dormant when
 * no `fetchAdsense` is wired (AFS access is OPEN_QUESTIONS #4) — returns 0 without touching anything.
 */
export async function pullAdsenseRevenue(
  since: string,
  until: string,
  deps: AttributionDeps = defaultDeps,
): Promise<{ rows: number; offerRows: number }> {
  if (!deps.fetchAdsense) return { rows: 0, offerRows: 0 };

  // Only channels that HELD a campaign during [since, until] need a report — bounds the
  // channel filter when an AFS partner account has 10k+ custom channels.
  const sinceStartUtc = zonedStartOfDayUtc(since);
  const assigned = await withSystem((tx) =>
    tx.channelAssignment.findMany({
      where: { forDay: { lte: until }, OR: [{ releasedAt: null }, { releasedAt: { gte: sinceStartUtc } }] },
      select: { channelRef: true },
      distinct: ['channelRef'],
    }),
  );
  if (assigned.length === 0) return { rows: 0, offerRows: 0 };

  const channels = await withSystem((tx) =>
    tx.channel.findMany({ where: { id: { in: assigned.map((a) => a.channelRef) } }, select: { id: true, channelId: true, domainId: true } }),
  );
  const channelRefByCh = new Map(channels.map((c) => [c.channelId, c.id]));

  // Resolve each channel's AFS account: offer channel → its domain's account; legacy → platform.
  const domainIds = [...new Set(channels.map((c) => c.domainId).filter((d): d is string => Boolean(d)))];
  const domains = domainIds.length
    ? await withSystem((tx) => tx.domain.findMany({ where: { id: { in: domainIds } }, select: { id: true, afsAccountId: true } }))
    : [];
  const acctByDomain = new Map(domains.map((d) => [d.id, d.afsAccountId]));
  // Legacy global channels (no domain) → the platform account; the 'platform' sentinel is
  // a live no-op when no such connection exists (so dormant/test deploys stay revenue-empty).
  const fallbackAcct = (channels.some((c) => !c.domainId) ? await defaultAfsAccountId() : null) ?? 'platform';

  const channelsByAccount = new Map<string, string[]>();
  for (const c of channels) {
    const acct = (c.domainId ? acctByDomain.get(c.domainId) : fallbackAcct) ?? 'platform';
    const list = channelsByAccount.get(acct) ?? [];
    list.push(c.channelId);
    channelsByAccount.set(acct, list);
  }

  const report = await deps.fetchAdsense({
    since,
    until,
    accounts: [...channelsByAccount].map(([afsAccountId, channelIds]) => ({ afsAccountId, channelIds })),
  });

  // Write per-offer revenue + the campaign rollup in ONE transaction, so a mid-pull crash can't
  // leave a half-written day. The report was already fetched above (no network inside the txn), and
  // the raised timeout covers a large report's many upserts past the default 5s interactive-tx limit.
  // Re-pulls stay idempotent (every write is keyed on (entity, day)).
  return withSystem(
    async (tx): Promise<{ rows: number; offerRows: number }> => {
      // Pass 1: per-offer revenue + accumulate the campaign rollup (summed across channels).
      const rollup = new Map<string, CampaignDayRollup>();
      let offerRows = 0;
      for (const r of report) {
        const channelRef = channelRefByCh.get(r.channelId);
        if (!channelRef) continue;
        const rate = await deps.getRate(tx, r.day, r.currency);
        const revenueUsdMinor = toUsdMinor(r.revenueMinor, rate);
        const suppressed = r.afsClicks < AFS_CLICK_SUPPRESSION_THRESHOLD;

        // Per-offer: the offer that holds this channel (if any).
        const fill = { afsRequests: r.requests ?? 0, afsMatchedRequests: r.matchedRequests ?? 0, afsImpressions: r.impressions ?? 0 };
        const offer = await tx.offer.findFirst({ where: { channelRef }, select: { id: true, orgId: true, campaignId: true } });
        if (offer) {
          await tx.offerRevenueDaily.upsert({
            where: { offerId_day: { offerId: offer.id, day: r.day } },
            create: { orgId: offer.orgId, offerId: offer.id, campaignId: offer.campaignId, channelRef, day: r.day, afsClicks: r.afsClicks, revenueMinor: r.revenueMinor, revenueUsdMinor, currency: r.currency, suppressed, ...fill },
            update: { campaignId: offer.campaignId, channelRef, afsClicks: r.afsClicks, revenueMinor: r.revenueMinor, revenueUsdMinor, currency: r.currency, suppressed, ...fill },
          });
          offerRows += 1;
        }

        // Campaign rollup: the campaign holding this channel on day `r.day` (the span, D7).
        const span = await tx.channelAssignment.findFirst({
          where: { channelRef, forDay: r.day },
          orderBy: { assignedAt: 'desc' },
          select: { campaignId: true, orgId: true },
        });
        if (!span) continue;
        const key = `${span.campaignId}|${r.day}`;
        const cur = rollup.get(key);
        if (cur) {
          cur.revenueMinor += r.revenueMinor;
          cur.revenueUsdMinor += revenueUsdMinor;
          cur.afsClicks += r.afsClicks;
          cur.afsRequests += fill.afsRequests;
          cur.afsMatchedRequests += fill.afsMatchedRequests;
          cur.afsImpressions += fill.afsImpressions;
          cur.currencies.add(r.currency);
        } else {
          rollup.set(key, {
            orgId: span.orgId,
            campaignId: span.campaignId,
            day: r.day,
            channelRef,
            revenueMinor: r.revenueMinor,
            revenueUsdMinor,
            afsClicks: r.afsClicks,
            ...fill,
            currencies: new Set([r.currency]),
          });
        }
      }

      // Pass 2: upsert the campaign rollup (sum). When offers span >1 currency the native sum
      // is meaningless (D15), so report USD as the native amount; USD is always summable.
      let rows = 0;
      for (const v of rollup.values()) {
        const mixed = v.currencies.size > 1;
        await tx.campaignRevenueDaily.upsert({
          where: { campaignId_day: { campaignId: v.campaignId, day: v.day } },
          create: {
            orgId: v.orgId,
            campaignId: v.campaignId,
            channelRef: v.channelRef,
            day: v.day,
            afsClicks: v.afsClicks,
            revenueMinor: mixed ? v.revenueUsdMinor : v.revenueMinor,
            revenueUsdMinor: v.revenueUsdMinor,
            currency: mixed ? 'USD' : [...v.currencies][0]!,
            suppressed: v.afsClicks < AFS_CLICK_SUPPRESSION_THRESHOLD,
            afsRequests: v.afsRequests,
            afsMatchedRequests: v.afsMatchedRequests,
            afsImpressions: v.afsImpressions,
          },
          update: {
            channelRef: v.channelRef,
            afsClicks: v.afsClicks,
            revenueMinor: mixed ? v.revenueUsdMinor : v.revenueMinor,
            revenueUsdMinor: v.revenueUsdMinor,
            currency: mixed ? 'USD' : [...v.currencies][0]!,
            suppressed: v.afsClicks < AFS_CLICK_SUPPRESSION_THRESHOLD,
            afsRequests: v.afsRequests,
            afsMatchedRequests: v.afsMatchedRequests,
            afsImpressions: v.afsImpressions,
          },
        });
        rows += 1;
      }
      return { rows, offerRows };
    },
    { timeout: 120_000 },
  );
}

// ── 3. Allocate campaign revenue across ads → ad_revenue_daily ────────────────

/** Effective platform cut for a campaign's buyer (buyer override ?? org default). */
async function effectiveCutPct(tx: TxClient, orgId: string, buyerId: string): Promise<number> {
  const [org, buyer] = await Promise.all([
    tx.organization.findUnique({ where: { id: orgId }, select: { defaultRevenueCutPct: true } }),
    tx.user.findUnique({ where: { id: buyerId }, select: { revenueCutPct: true } }),
  ]);
  const cut = buyer?.revenueCutPct ?? org?.defaultRevenueCutPct ?? 0;
  return Number(cut);
}

/**
 * Allocate one campaign's gross USD revenue for `day` across its ads (D8 + fallback),
 * apply the revenue cut, and upsert `ad_revenue_daily`. Idempotent. Returns the number
 * of ad rows written (0 when there's no revenue row for the day).
 */
export async function allocateRevenueForCampaignDay(
  tx: TxClient,
  campaignId: string,
  day: string,
): Promise<number> {
  const rev = await tx.campaignRevenueDaily.findUnique({
    where: { campaignId_day: { campaignId, day } },
    select: { revenueUsdMinor: true, orgId: true },
  });
  if (!rev) return 0;

  const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, select: { buyerId: true } });
  if (!campaign) return 0;

  const ads = await tx.ad.findMany({ where: { adSet: { campaignId } }, select: { id: true } });
  if (ads.length === 0) return 0;

  const statsByAd = new Map(
    (
      await tx.adStatsDaily.findMany({
        where: { adId: { in: ads.map((a) => a.id) }, day },
        select: { adId: true, conversions: true, clicks: true, impressions: true },
      })
    ).map((s) => [s.adId, s]),
  );

  const signals: AdSignals[] = ads.map((a) => {
    const s = statsByAd.get(a.id);
    return { conversions: s?.conversions ?? 0, clicks: s?.clicks ?? 0, impressions: s?.impressions ?? 0 };
  });

  const { basis, allocations } = allocateCampaignRevenue(rev.revenueUsdMinor, signals);
  const cut = await effectiveCutPct(tx, rev.orgId, campaign.buyerId);

  let n = 0;
  for (let i = 0; i < ads.length; i++) {
    const ad = ads[i];
    if (!ad) continue;
    const allocated = allocations[i] ?? 0;
    const { visibleCents, marginCents } = applyRevenueCut(allocated, cut);
    await tx.adRevenueDaily.upsert({
      where: { adId_day: { adId: ad.id, day } },
      create: {
        orgId: rev.orgId,
        adId: ad.id,
        campaignId,
        day,
        conversions: signals[i]?.conversions ?? 0,
        allocatedUsdMinor: allocated,
        visibleUsdMinor: visibleCents,
        marginUsdMinor: marginCents,
        basis,
      },
      update: {
        conversions: signals[i]?.conversions ?? 0,
        allocatedUsdMinor: allocated,
        visibleUsdMinor: visibleCents,
        marginUsdMinor: marginCents,
        basis,
      },
    });
    n += 1;
  }
  return n;
}

/** Allocate revenue for every campaign that has a revenue row on any of `days`. */
export async function allocateRevenue(days: string[]): Promise<{ campaignDays: number }> {
  let count = 0;
  for (const day of days) {
    const revRows = await withSystem((tx) =>
      tx.campaignRevenueDaily.findMany({ where: { day }, select: { campaignId: true } }),
    );
    for (const { campaignId } of revRows) {
      await withSystem((tx) => allocateRevenueForCampaignDay(tx, campaignId, day));
      count += 1;
    }
  }
  return { campaignDays: count };
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/** Pull + allocate for a set of days (idempotent). */
export async function runAttribution(
  days: string[],
  deps: AttributionDeps = defaultDeps,
): Promise<void> {
  if (days.length === 0) return;
  const since = days[0]!;
  const until = days[days.length - 1]!;
  await deps.ensureFx?.(days);
  await pullFbStats(since, until, deps);
  await pullAdsenseRevenue(since, until, deps);
  await allocateRevenue(days);
}

/** Hourly refresh: re-pull + re-allocate today's IST business day. */
export async function runHourlyAttribution(
  now: Date = new Date(),
  deps: AttributionDeps = defaultDeps,
): Promise<void> {
  await runAttribution([businessDay(now)], deps);
}

/**
 * Data finalization (§5.8): re-pull the trailing windows (FB last FB_REPULL_DAYS,
 * AdSense last ADSENSE_REPULL_DAYS) and re-allocate. Upserts make this idempotent.
 */
export async function runFinalization(
  now: Date = new Date(),
  deps: AttributionDeps = defaultDeps,
): Promise<void> {
  const today = businessDay(now);
  const adsenseDays = recentDays(today, FINALIZATION.ADSENSE_REPULL_DAYS);
  const fbDays = recentDays(today, FINALIZATION.FB_REPULL_DAYS);
  // FB has the shorter window; AdSense the longer. Pull each over its own range,
  // then re-allocate the union (= the AdSense window, the superset).
  await deps.ensureFx?.(adsenseDays);
  await pullFbStats(fbDays[0]!, fbDays[fbDays.length - 1]!, deps);
  await pullAdsenseRevenue(adsenseDays[0]!, adsenseDays[adsenseDays.length - 1]!, deps);
  await allocateRevenue(adsenseDays);
}
