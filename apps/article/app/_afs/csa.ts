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
 *  parse it as a search context signal (it's just carrier metadata for our SSR to decode). */
export const AFS_TRACKING_PARAMS =
  't,rc,terms,txid,clickid,utm_source,utm_content,utm_campaign,utm_medium,utm_term,fbclid,hl,styleId,placement,s1,ds,camp_id';

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
