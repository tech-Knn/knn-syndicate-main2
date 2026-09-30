import { env } from '@knn/config';
import { WhopConnectionStatus, type TxClient, withSystem } from '@knn/db';
import {
  AD_CLICK_EVENT_NAME,
  CAMPAIGN_STATUS,
  DEFAULT_BUSINESS_TZ,
  businessDayBoundsUtc,
  businessDaysInRange,
  toUsdMinor,
  zonedStartOfDayUtc,
} from '@knn/shared';
import type { WhopAd, WhopAdsApi } from '@knn/whop';
import {
  PassBudget,
  TRANSPORT_FAILURES_BEFORE_STOP,
  type WhopConnectionRow,
  handleWhopReadFailure,
  nextTransportFailures,
  resolveWhopConnection,
  rotate,
  whopAdsForConnection,
} from '../lib/whop-auth.js';
import { getUsdRate } from './fx.service.js';

/**
 * Whop spend -> `ad_stats_daily` (D33, phase 2): the Whop twin of the Facebook insights pull. Whop reports each ad's
 * delivery over a window, so one bulk read per business per IST day (an explicit window in `Asia/Kolkata`, the business
 * day everything else keys on, D4) fills a row per ad. The revenue allocation downstream (D8) is unchanged: it reads these
 * rows exactly as it reads Facebook's.
 *
 * What goes in a row, mirroring the Facebook pull:
 *  - `clicks` are LINK clicks (the clicks that reach the article), as Facebook's `inline_link_clicks`.
 *  - `spendMinor` is the amount in the currency Whop reports it in (x100, the same 2-decimal assumption as Facebook),
 *    converted to USD with that day's FX rate.
 *  - `conversions` is the weight revenue is split by. OUR OWN first-party money events per ad come first: every ad has its own
 *    go-link, so a conversion event maps to exactly one ad, and the count is exact (and is what Analytics counts, by the
 *    same `createdAt` day). Whop's attributed count (`submitted_applications`, its last-click count of the same event) is at
 *    most a lagged, matched subset of what we sent it, so it is only the fallback for a campaign-day on which we recorded
 *    none (events not flowing). One scale per campaign-day, never per ad, so one day's ads are never weighed on two scales.
 *
 * NEVER ERASES RECORDED DELIVERY. Whop's own figures (impressions, clicks, spend, its count) decide whether Whop "reported
 * something" for an ad and day, and only then is the whole row rewritten. A day Whop reads as all zeroes is left alone, and
 * so is one where it sends nothing: after a relaunch (or a rebuild) one of our ad rows points at a NEW Whop ad that has no
 * history, so "Whop says zero for the days before it existed" must not overwrite what the old ad really spent. What still
 * refreshes on such a day is the conversion count, and only that (`update: { conversions }`): it is our own, it is what the
 * revenue is weighed by, and it is not Whop's to erase. The cost is that a day Whop later revises DOWN to exactly zero keeps
 * its old figure (the same as Facebook, whose rows only exist for days with delivery).
 */

export interface WhopStatsDeps {
  /** Whop Ads is on (`WHOP_ADS_ENABLED`). The company switch is NOT consulted: spend on live campaigns must keep landing. */
  enabled?: () => boolean;
  adsFor?: (conn: WhopConnectionRow) => WhopAdsApi;
  getRate?: (tx: TxClient, day: string, currency: string) => Promise<number>;
  /** Stop starting new businesses after this long (ms); the hourly revenue run must not wait on a slow Whop. Default 5 min. */
  budgetMs?: number;
  /** The clock (ms) the budget runs on; tests move it. */
  clock?: () => number;
  /** Where in the (stable) order of businesses this pass starts, as a number in [0, 1). Random by default; tests fix it. */
  rand?: () => number;
}

interface ScopedCampaign {
  id: string;
  orgId: string;
  buyerId: string;
  whopCampaignId: string;
  whopConnectionId: string | null;
  whopBizId: string | null;
  ads: { id: string; whopAdId: string | null }[];
}

/** Whop's own count of our money event for an ad (its last-click `submit_application`), when it reports one. */
function whopMoneyCount(a: WhopAd): number {
  return typeof a.submitted_applications === 'number' ? Math.max(0, Math.round(a.submitted_applications)) : 0;
}

/**
 * Our own count of the money event per ad for one business day. Bounded by `createdAt`, like every Analytics count of these
 * events (`eventTime` is set at the same moment at ingest): it is the column the (campaign, event, created_at) index is on, so
 * this reads one day's rows, not the campaign's whole ad-click history.
 */
async function ownConversions(tx: TxClient, campaignId: string, start: Date, end: Date): Promise<Map<string, number>> {
  const rows = await tx.conversionEvent.groupBy({
    by: ['adId'],
    where: { campaignId, provider: 'whop', eventName: AD_CLICK_EVENT_NAME, createdAt: { gte: start, lt: end } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.adId, r._count._all]));
}

/** Write one campaign's ads for one day. Returns how many rows were written. */
async function writeCampaignDay(
  c: ScopedCampaign,
  conn: WhopConnectionRow,
  day: string,
  whopAds: readonly WhopAd[],
  getRate: NonNullable<WhopStatsDeps['getRate']>,
): Promise<number> {
  // An ad is ours if OUR row for this campaign names it; Whop's own pointer to a campaign is not relied on.
  const ours = new Map(c.ads.filter((a) => a.whopAdId).map((a) => [a.whopAdId as string, a.id]));
  const mine = whopAds.filter((a) => ours.has(a.id));
  if (mine.length === 0) return 0;
  const { start, end } = businessDayBoundsUtc(day);

  return withSystem(async (tx) => {
    const own = await ownConversions(tx, c.id, start, end);
    const useOwn = [...own.values()].reduce((a, b) => a + b, 0) > 0;
    let n = 0;
    for (const a of mine) {
      const adId = ours.get(a.id)!;
      const whopCount = whopMoneyCount(a);
      const impressions = Math.max(0, Math.round(a.impressions ?? 0));
      const clicks = Math.max(0, Math.round(a.link_clicks ?? a.clicks ?? 0));
      const spendMinor = Math.max(0, Math.round((a.spend ?? 0) * 100));
      const conversions = useOwn ? own.get(adId) ?? 0 : whopCount;

      // Did WHOP report anything for this ad and day? Decided from Whop's figures alone: our own conversion count must never
      // make an idle day look like a reported one, or a relaunch would wipe the old ad's spend with zeroes.
      if (impressions === 0 && clicks === 0 && spendMinor === 0 && whopCount === 0) {
        if (conversions > 0) {
          await tx.adStatsDaily.upsert({
            where: { adId_day: { adId, day } },
            create: { orgId: c.orgId, adId, campaignId: c.id, day, conversions },
            update: { conversions },
          });
          n += 1;
        }
        continue;
      }

      const currency = (a.spend_currency ?? conn.reportingCurrency ?? 'USD').toUpperCase();
      const rate = await getRate(tx, day, currency);
      const data = { impressions, clicks, conversions, spendMinor, spendUsdMinor: toUsdMinor(spendMinor, rate), currency };
      await tx.adStatsDaily.upsert({
        where: { adId_day: { adId, day } },
        create: { orgId: c.orgId, adId, campaignId: c.id, day, ...data },
        update: data,
      });
      n += 1;
    }
    return n;
  });
}

interface BusinessResult {
  /** `transport`: Whop did not answer (down / slow). `answered`: it did, whatever it said. `skipped`: we could not even try. */
  outcome: 'transport' | 'answered' | 'skipped';
  rows: number;
  touched: string[];
}

/** One business: its campaigns' ads for every day in the window, containing every failure to the business. */
async function pullBusiness(
  conn: WhopConnectionRow,
  group: ScopedCampaign[],
  since: string,
  until: string,
  adsFor: NonNullable<WhopStatsDeps['adsFor']>,
  getRate: NonNullable<WhopStatsDeps['getRate']>,
): Promise<BusinessResult> {
  const result: BusinessResult = { outcome: 'answered', rows: 0, touched: [] };
  let ads: WhopAdsApi;
  try {
    ads = adsFor(conn);
  } catch (err) {
    console.error(`[attribution] cannot use the Whop key of ${conn.bizId}:`, err instanceof Error ? err.message : String(err));
    result.outcome = 'skipped';
    return result;
  }
  // Ask only for campaigns Whop still has: a campaign deleted in Whop must not make the batch refuse the rest.
  let ids = group.map((c) => c.whopCampaignId);
  try {
    const existing = new Set((await ads.listCampaigns({ accountId: conn.bizId })).map((w) => w.id));
    ids = ids.filter((id) => existing.has(id));
  } catch (err) {
    const kind = await handleWhopReadFailure(conn, err);
    if (kind !== 'other') {
      console.error(`[attribution] Whop stats read failed for ${conn.bizId} (${kind}):`, err instanceof Error ? err.message : String(err));
      if (kind === 'transport') result.outcome = 'transport';
      return result;
    }
  }
  if (ids.length === 0) return result;

  for (const day of businessDaysInRange(since, until)) {
    const { start, end } = businessDayBoundsUtc(day);
    let list: WhopAd[];
    try {
      // `to` is the last second of the day: Whop may treat it as inclusive, and the next day's first instant is not ours.
      list = await ads.listAds({ accountId: conn.bizId, campaignIds: ids, stats: { from: start.toISOString(), to: new Date(end.getTime() - 1000).toISOString(), timeZone: DEFAULT_BUSINESS_TZ } });
    } catch (err) {
      const kind = await handleWhopReadFailure(conn, err);
      console.error(`[attribution] Whop stats read failed for ${conn.bizId} on ${day} (${kind}):`, err instanceof Error ? err.message : String(err));
      if (kind === 'transport') result.outcome = 'transport';
      break; // the rest of this business's days would fail the same way
    }
    for (const c of group) {
      try {
        const n = await writeCampaignDay(c, conn, day, list, getRate);
        result.rows += n;
        if (n > 0 && !result.touched.includes(c.id)) result.touched.push(c.id);
      } catch (err) {
        console.error(`[attribution] Whop stats write failed for campaign ${c.id} on ${day}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return result;
}

/**
 * Pull Whop's delivery for every launched Whop campaign over the business days [since, until]. Per-business
 * failures are contained: a rejected key (or one that may not read the ads) breaks that connection, once; an outage skips it;
 * neither stops another business (or the Facebook pull) from being read. A pass has a time budget and stops early when several
 * businesses in a row fail on transport (a rate limit or a rejected key is Whop ANSWERING, so it does not count), so a slow
 * Whop can never hold up the revenue run behind it. Businesses are visited in a rotating order, so an early stop never starves
 * the same ones every time.
 */
export async function pullWhopStats(since: string, until: string, deps: WhopStatsDeps = {}): Promise<{ campaigns: number; rows: number }> {
  const enabled = deps.enabled ?? ((): boolean => env.WHOP_ADS_ENABLED);
  if (!enabled()) return { campaigns: 0, rows: 0 };
  const adsFor = deps.adsFor ?? whopAdsForConnection;
  const getRate = deps.getRate ?? getUsdRate;
  const budget = new PassBudget(deps.budgetMs ?? 5 * 60_000, deps.clock);

  const rows = await withSystem((tx) =>
    tx.campaign.findMany({
      where: {
        adProvider: 'WHOP',
        whopCampaignId: { not: null },
        // Archived campaigns keep reporting late spend for a while: read them only while their window still overlaps.
        OR: [
          { status: { in: [CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED, CAMPAIGN_STATUS.META_REJECTED] } },
          { status: CAMPAIGN_STATUS.ARCHIVED, updatedAt: { gte: zonedStartOfDayUtc(since) } },
        ],
      },
      select: {
        id: true,
        orgId: true,
        buyerId: true,
        whopCampaignId: true,
        whopConnectionId: true,
        whopBizId: true,
        adSets: { select: { ads: { select: { id: true, whopAdId: true } } } },
      },
    }),
  );
  const campaigns: ScopedCampaign[] = rows.map((r) => ({ ...r, whopCampaignId: r.whopCampaignId!, ads: r.adSets.flatMap((s) => s.ads) }));

  const groups = new Map<string, { conn: WhopConnectionRow; campaigns: ScopedCampaign[] }>();
  const resolved = new Map<string, WhopConnectionRow | null>();
  for (const c of campaigns) {
    const refKey = `${c.whopConnectionId ?? ''}|${c.orgId}|${c.buyerId}|${c.whopBizId ?? ''}`;
    if (!resolved.has(refKey)) resolved.set(refKey, await resolveWhopConnection(c));
    const conn = resolved.get(refKey) ?? null;
    // No connection, or a key known to be bad: nothing to read. Never an error: the next tick tries again.
    if (!conn || conn.status === WhopConnectionStatus.BROKEN) continue;
    const g = groups.get(conn.id) ?? { conn, campaigns: [] };
    g.campaigns.push(c);
    groups.set(conn.id, g);
  }
  const ordered = rotate([...groups.values()].sort((a, b) => a.conn.id.localeCompare(b.conn.id)), (deps.rand ?? Math.random)());

  const touched = new Set<string>();
  let written = 0;
  let transportFailures = 0;
  for (const [i, { conn, campaigns: group }] of ordered.entries()) {
    if (budget.expired()) {
      console.warn(`[attribution] Whop stats: time budget reached, ${ordered.length - i} business(es) are left for the next run`);
      break;
    }
    if (transportFailures >= TRANSPORT_FAILURES_BEFORE_STOP) {
      console.warn(`[attribution] Whop stats: ${transportFailures} businesses in a row failed to answer, stopping this pass (${ordered.length - i} left)`);
      break;
    }
    const r = await pullBusiness(conn, group, since, until, adsFor, getRate);
    transportFailures = nextTransportFailures(transportFailures, r.outcome);
    written += r.rows;
    for (const id of r.touched) touched.add(id);
  }
  return { campaigns: touched.size, rows: written };
}
