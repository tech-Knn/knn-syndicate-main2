import { type TxClient, FbConnectionStatus, withSystem } from '@knn/db';
import type { ChannelDayRevenue } from '@knn/adsense';
import { type FbAdInsightRow, decryptToken, fetchAdInsights } from '@knn/fb';
import {
  AFS_CLICK_SUPPRESSION_THRESHOLD,
  type AdSignals,
  FINALIZATION,
  allocateCampaignRevenue,
  applyRevenueCut,
  businessDay,
  toUsdMinor,
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
  /** AFS revenue source. Dormant by default (AFS API access is OPEN_QUESTIONS #4). */
  fetchAdsense?: (params: { since: string; until: string; channelIds: string[] }) => Promise<ChannelDayRevenue[]>;
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
    if (!campaign.adAccountId) return 0;
    const conn = await tx.fbConnection.findUnique({ where: { userId: campaign.buyerId } });
    if (!conn || conn.status === FbConnectionStatus.CONNECTION_BROKEN) return 0;
    const account = await tx.fbAdAccount.findUnique({
      where: { id: campaign.adAccountId },
      select: { fbAccountId: true, currency: true },
    });
    if (!account) return 0;

    const ads = await tx.ad.findMany({
      where: { adSet: { campaignId: campaign.id }, fbAdId: { not: null } },
      select: { id: true, fbAdId: true },
    });
    const adByFbId = new Map(ads.map((a) => [a.fbAdId as string, a.id]));
    if (adByFbId.size === 0) return 0;

    const rows: FbAdInsightRow[] = await deps.fetchInsights({
      fbCampaignId: campaign.fbCampaignId,
      accountId: account.fbAccountId,
      accessToken: decryptToken(conn.accessTokenEnc),
      since,
      until,
    });

    let n = 0;
    for (const row of rows) {
      const adId = adByFbId.get(row.fbAdId);
      if (!adId) continue;
      const rate = await deps.getRate(tx, row.day, account.currency);
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
          currency: account.currency,
        },
        update: {
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
          spendMinor: row.spendMinor,
          spendUsdMinor: toUsdMinor(row.spendMinor, rate),
          currency: account.currency,
        },
      });
      n += 1;
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
      select: { id: true, orgId: true, buyerId: true, fbCampaignId: true, adAccountId: true },
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

/**
 * Pull AFS revenue per channel for [since, until] and record it on the campaign that
 * held each channel that day. Dormant when no `fetchAdsense` is wired (AFS access is
 * OPEN_QUESTIONS #4) — returns 0 without touching anything.
 */
export async function pullAdsenseRevenue(
  since: string,
  until: string,
  deps: AttributionDeps = defaultDeps,
): Promise<{ rows: number }> {
  if (!deps.fetchAdsense) return { rows: 0 };

  const channels = await withSystem((tx) => tx.channel.findMany({ select: { id: true, channelId: true } }));
  const channelRefByCh = new Map(channels.map((c) => [c.channelId, c.id]));
  const report = await deps.fetchAdsense({ since, until, channelIds: channels.map((c) => c.channelId) });

  let rows = 0;
  for (const r of report) {
    const channelRef = channelRefByCh.get(r.channelId);
    if (!channelRef) continue;
    const recorded = await withSystem(async (tx) => {
      // The campaign holding this channel on day `r.day` (the attribution span, D7).
      const span = await tx.channelAssignment.findFirst({
        where: { channelRef, forDay: r.day },
        orderBy: { assignedAt: 'desc' },
        select: { campaignId: true, orgId: true },
      });
      if (!span) return false;
      const rate = await deps.getRate(tx, r.day, r.currency);
      const revenueUsdMinor = toUsdMinor(r.revenueMinor, rate);
      const suppressed = r.afsClicks < AFS_CLICK_SUPPRESSION_THRESHOLD;
      await tx.campaignRevenueDaily.upsert({
        where: { campaignId_day: { campaignId: span.campaignId, day: r.day } },
        create: {
          orgId: span.orgId,
          campaignId: span.campaignId,
          channelRef,
          day: r.day,
          afsClicks: r.afsClicks,
          revenueMinor: r.revenueMinor,
          revenueUsdMinor,
          currency: r.currency,
          suppressed,
        },
        update: {
          channelRef,
          afsClicks: r.afsClicks,
          revenueMinor: r.revenueMinor,
          revenueUsdMinor,
          currency: r.currency,
          suppressed,
        },
      });
      return true;
    });
    if (recorded) rows += 1;
  }
  return { rows };
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
