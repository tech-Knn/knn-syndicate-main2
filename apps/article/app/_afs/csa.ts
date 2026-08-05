/**
 * Google Custom Search Ads (CSA) loader — the runtime half of AdSense for Search
 * / RSOC. Mirrors the exact bootstrap from the AdSense code generator:
 *   (function(g,o){g[o]=g[o]||function(){(g[o].q=g[o].q||[]).push(arguments)},
 *    g[o].t=1*new Date})(window,'_googCsa');
 * then `_googCsa(command, pageOptions, ...blocks)`, with `ads.js` loaded async
 * (it drains the queue). Client-only — call from a useEffect.
 *
 * Config informed by a live RSOC arbitrage funnel: ignore tracking params so they
 * don't pollute content-term generation, open ads in a new tab, report load
 * callbacks, and keep adsafe out of the over-filtering "high" bucket.
 */
type GoogCsa = ((command: string, ...rest: unknown[]) => void) & {
  q?: unknown[];
  t?: number;
};

const ADS_JS = 'https://www.google.com/adsense/search/ads.js';
const ADS_JS_ID = 'google-adsense-search';

/** Our tracking / redirect params — Google should ignore these when generating
 *  content-based related searches (otherwise they pollute term relevance).
 *  `ch` and `cid` intentionally NOT in this list — channel is a real attribution field
 *  (sent via pageOptions.channel) and should be treated by Google as such, not ignored. */
export const AFS_TRACKING_PARAMS =
  'rc,terms,txid,clickid,utm_source,utm_content,utm_campaign,utm_medium,utm_term,fbclid,hl,styleId,placement,s1,ds,camp_id';

/** Queue a CSA command and ensure ads.js is loaded to process it. */
export function runCsa(command: 'ads' | 'relatedsearch', ...rest: unknown[]): void {
  const w = window as unknown as { _googCsa?: GoogCsa; pageOptions?: unknown; PageOptions?: unknown };
  // Some AdSense custom-style templates (looked up by `styleId` in the request) contain
  // publisher code that expects `window.PageOptions` / `window.pageOptions` to be defined —
  // e.g. `PageOptions.pubId`. When it isn't, the style throws `ReferenceError: PageOptions
  // is not defined` inside Google's ads.js, and the unit renders empty. Expose the current
  // page-options object under both casings before firing, so a style referencing either works.
  // Only the CSA command payload is authoritative for ad serving; these globals are read-only
  // for the style template.
  const pageOptions = rest[0];
  if (pageOptions && typeof pageOptions === 'object') {
    w.pageOptions = pageOptions;
    w.PageOptions = pageOptions;
  }
  if (!w._googCsa) {
    const queue: unknown[] = [];
    const stub = ((...args: unknown[]) => {
      queue.push(args);
    }) as unknown as GoogCsa;
    stub.q = queue;
    stub.t = Date.now();
    w._googCsa = stub;
  }
  w._googCsa(command, ...rest);

  if (!document.getElementById(ADS_JS_ID)) {
    const script = document.createElement('script');
    script.id = ADS_JS_ID;
    script.async = true;
    script.src = ADS_JS;
    document.head.appendChild(script);
  }
}

/** Fired by CSA when a unit finishes loading — `adsLoaded` says whether it filled.
 *  Phase 9 will POST this to a funnel-telemetry endpoint keyed by the redirect
 *  click id; for now it surfaces in dev so we can see whether a unit served. */
export function afsAdLoadedCallback(containerName: string, adsLoaded: boolean): void {
  if (process.env.NODE_ENV !== 'production') {
    console.debug(`[afs] ${containerName} adsLoaded=${adsLoaded}`);
  }
}

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

/** Shared page-level options from the resolved per-host config + the results page URL. */
export function basePageOptions(config: SiteConfig, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const options: Record<string, unknown> = {
    pubId: config.pubId,
    styleId: config.styleId,
    hl: 'en',
    // adsafe: 'high' over-filters (fewer ads); arbitrage funnels run 'low'/'medium'.
    adsafe: config.adsafe || 'medium',
    ivt: false,
    // The results page that related-search terms link to (same approved host).
    resultsPageBaseUrl: `${window.location.origin}/search`,
    resultsPageQueryParam: 'q',
    ignoredPageParams: AFS_TRACKING_PARAMS,
    ...extra,
  };
  // Test mode: safe for verifying the integration (avoids self-click policy issues).
  if (config.adtest) options.adtest = 'on';
  return options;
}

/** True when an AFS pubId is resolved for this host (only then do real units render). */
export function afsConfigured(config: SiteConfig): boolean {
  return Boolean(config.pubId);
}
