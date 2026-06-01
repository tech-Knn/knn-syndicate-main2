import { type FbRateLimiter, sharedRateLimiter } from './rate-limiter.js';
import { graphRequest } from './graph.js';

/**
 * Facebook Insights pull (Phase 9, D8). Reads per-ad daily insights for a launched
 * campaign — impressions, clicks, spend, and the pixel-conversion count that is the
 * D8 revenue-allocation weight. Goes through the per-account rate limiter (D12) like
 * every other Graph call. Spend is returned by FB as a decimal string in the AD
 * ACCOUNT's currency (major units); we store it as native minor units (×100, the
 * 2-decimal-currency assumption) plus a USD conversion done by the caller (D15).
 *
 * Day buckets use FB's `date_start` (the ad account's reporting timezone). For an
 * IST-timezone ad account this equals the IST business day the rest of the platform
 * keys on (D4); for other tz accounts it can differ by the offset — a known
 * approximation (hourly re-bucketing would remove it).
 */

/** A single FB "action" (conversion/engagement) row from insights. */
export interface FbAction {
  action_type: string;
  value: string;
}

/** Per-ad, per-day insight row (normalized; spend in native minor units). */
export interface FbAdInsightRow {
  fbAdId: string;
  day: string;
  impressions: number;
  clicks: number;
  spendMinor: number;
  conversions: number;
  /** Present only when a breakdown was requested: the country code or hour bucket. */
  dimValue?: string;
}

/** A FB insights breakdown dimension we support. */
export type FbBreakdown = 'country' | 'hour';
const BREAKDOWN_FIELD: Record<FbBreakdown, string> = {
  country: 'country',
  hour: 'hourly_stats_aggregated_by_advertiser_time_zone',
};

interface RawInsight {
  ad_id?: string;
  date_start?: string;
  impressions?: string;
  clicks?: string;
  spend?: string;
  actions?: FbAction[];
  country?: string;
  hourly_stats_aggregated_by_advertiser_time_zone?: string;
}

interface PagedInsights {
  data: RawInsight[];
  paging?: { cursors?: { after?: string }; next?: string };
}

const toInt = (s: string | undefined): number => Math.round(Number(s) || 0);

/**
 * The action_type of the MAIN (optimized) conversion — the ad click → FB `Search` event, where AFS
 * revenue is earned. The funnel ALSO fires `ViewContent` (lander page view) and `AddToCart` (/search
 * visit) via CAPI as optimization signal, but those are NOT the conversion: counting them inflates
 * "conversions" with page views. So `conversions` = the final ad-click only.
 */
export const MAIN_CONVERSION_ACTION_TYPE = 'offsite_conversion.fb_pixel_search';

/**
 * The per-ad conversion count = the **final / main conversion only** (the ad click = `Search` pixel
 * event). We deliberately count ONLY this action_type — NOT the sum of every `offsite_conversion.
 * fb_pixel_*` event — so the dashboard "conversions" matches the conversion the ad set optimizes
 * toward and the event that monetizes, and so the D8 revenue split weights by ad clicks (not by
 * landing-page views). Engagement actions (link_click, landing_page_view, …) are excluded too.
 * Pass a different `actionType` to count another standard event.
 */
export function extractConversions(actions: FbAction[] | undefined, actionType: string = MAIN_CONVERSION_ACTION_TYPE): number {
  if (!actions) return 0;
  return actions.filter((a) => a.action_type === actionType).reduce((sum, a) => sum + toInt(a.value), 0);
}

export interface FetchAdInsightsParams {
  /** The FB campaign id (the insights edge root). */
  fbCampaignId: string;
  /** The ad account id (`act_…` numeric) — gates the call by that account's limiter. */
  accountId: string;
  accessToken: string;
  /** Inclusive date range (YYYY-MM-DD), in the ad account's reporting timezone. */
  since: string;
  until: string;
  /** Optional FB breakdown: each row then carries `dimValue` (country code / hour bucket). */
  breakdown?: FbBreakdown;
}

/**
 * Fetch per-ad daily insights for a campaign over [since, until], following cursor
 * pagination. Returns one row per (ad, day). Empty when the campaign has no delivery.
 */
export async function fetchAdInsights(
  params: FetchAdInsightsParams,
  limiter: FbRateLimiter = sharedRateLimiter,
): Promise<FbAdInsightRow[]> {
  const rows: FbAdInsightRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await graphRequest<PagedInsights>(
      {
        path: `/${params.fbCampaignId}/insights`,
        method: 'GET',
        accessToken: params.accessToken,
        accountId: params.accountId,
        params: {
          level: 'ad',
          fields: 'ad_id,impressions,clicks,spend,actions',
          time_increment: '1',
          time_range: JSON.stringify({ since: params.since, until: params.until }),
          limit: '500',
          ...(params.breakdown ? { breakdowns: BREAKDOWN_FIELD[params.breakdown] } : {}),
          ...(after ? { after } : {}),
        },
      },
      limiter,
    );
    for (const r of res.data) {
      if (!r.ad_id || !r.date_start) continue;
      rows.push({
        fbAdId: r.ad_id,
        day: r.date_start,
        impressions: toInt(r.impressions),
        clicks: toInt(r.clicks),
        // Native minor units (account currency, 2-decimal assumption); USD via caller.
        spendMinor: Math.round((Number(r.spend) || 0) * 100),
        conversions: extractConversions(r.actions),
        ...(params.breakdown
          ? { dimValue: (params.breakdown === 'country' ? r.country : r.hourly_stats_aggregated_by_advertiser_time_zone) ?? 'unknown' }
          : {}),
      });
    }
    const next = res.paging?.next;
    after = res.paging?.cursors?.after;
    if (!next || !after) break;
  }
  return rows;
}
