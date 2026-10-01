/**
 * Google Custom Search Ads (CSA) — per-host AFS config + shared constants. Both
 * article-page and /search pages emit their own inline SSR bootstrap script that
 * fires `_googCsa(command, pageOptions, ...blocks)` during HTML parse. The old
 * client-side `runCsa` / `basePageOptions` helpers were removed 2026-09-24 after
 * moving the article page off `useEffect` (chips took 1–3s to render on mobile
 * because they waited for React to hydrate — see related-search-unit.tsx).
 */

/** Our tracking / redirect params — Google should ignore these when generating
 *  content-based related searches (otherwise they pollute term relevance).
 *  `ch` and `cid` intentionally NOT in this list — channel is a real attribution field
 *  (sent via pageOptions.channel) and should be treated by Google as such, not ignored.
 *  `t` = the signed cloak token (opaque base64 blob) — must be ignored so Google doesn't
 *  parse it as a search context signal (it's just carrier metadata for our SSR to decode).
 *  `_ws` = the signed Whop scope the redirect Worker adds to a Whop link's NON-paid landing (D33): an
 *  unlisted page-URL param hides the RSOC unit (D28), so it must be listed like `t`. */
export const AFS_TRACKING_PARAMS =
  't,rc,terms,txid,clickid,utm_source,utm_content,utm_campaign,utm_medium,utm_term,fbclid,hl,styleId,placement,s1,ds,camp_id,_ws';

/**
 * `adsafe` used when neither the domain (Domains admin) nor `NEXT_PUBLIC_AFS_ADSAFE` sets one
 * (D26). Google: 'high' = family-safe only · 'medium' = no adult sexual content · 'low' =
 * "Returns all types of ads" (no filtering, adult included). 'low' is what the team's
 * profitable RSOC pages on the same AdSense account run (149–154% India ROAS vs our 42% on
 * 'medium', Sep 17–29 2026) — the widest advertiser pool. Override per domain to go stricter.
 */
export const DEFAULT_ADSAFE = 'low';

/**
 * Reference layout (D41) — the knobs a competitor audit found identical on 83 of 83 live landing pages that share
 * our AdSense account (docs/DECISIONS.md D41). They are constants so the whole layout can be reverted in one place.
 *
 *  · `DEFAULT_AFS_STYLE_ID` — the style used when neither the domain (Domains admin) nor `NEXT_PUBLIC_AFS_STYLE_ID`
 *    sets one. A domain's own style still wins.
 *  · `RSOC_CHIPS_PER_UNIT` / `RSOC_UNITS` — the article page runs TWO related-search units of 6 chips each.
 *  · `RESULTS_MAX_ADS` / `RESULTS_ORGANIC_COUNT` — the results page shows ONE top ad (`maxTop`) above ONE organic
 *    result (Google's "ads ≤ results" rule still holds: 1 ≤ 1).
 */
export const DEFAULT_AFS_STYLE_ID = '8472563621';
export const RSOC_UNITS = 2;
export const RSOC_CHIPS_PER_UNIT = 6;
export const RESULTS_MAX_ADS = 1;
export const RESULTS_ORGANIC_COUNT = 1;

/**
 * AFS monetization config for the CURRENT request's host (Phase D). Resolved
 * server-side from the registered Domain → its AFS account's pubId (+ the domain's
 * style/adsafe), so one article app serves many websites under their own accounts.
 * See `_afs/site-config.ts#resolveSiteConfig`.
 */
export interface SiteConfig {
  pubId: string;
  styleId: string;
  adsafe: string;
  /** Test mode: renders without counting impressions/clicks or paying. */
  adtest: boolean;
}

/** True when an AFS pubId is resolved for this host (only then do real units render). */
export function afsConfigured(config: SiteConfig): boolean {
  return Boolean(config.pubId);
}
