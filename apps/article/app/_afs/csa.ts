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
 *  content-based related searches (otherwise they pollute term relevance). */
export const AFS_TRACKING_PARAMS =
  'rc,ch,terms,txid,clickid,utm_source,utm_content,utm_campaign,utm_medium,utm_term,fbclid,hl,styleId,placement,s1,ds,camp_id';

/** Queue a CSA command and ensure ads.js is loaded to process it. */
export function runCsa(command: 'ads' | 'relatedsearch', ...rest: unknown[]): void {
  const w = window as unknown as { _googCsa?: GoogCsa };
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

/** Shared page-level options from env (build-time NEXT_PUBLIC_*) + the results page URL. */
export function basePageOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const options: Record<string, unknown> = {
    pubId: process.env.NEXT_PUBLIC_AFS_PUB_ID ?? '',
    styleId: process.env.NEXT_PUBLIC_AFS_STYLE_ID ?? '',
    hl: 'en',
    // adsafe: 'high' over-filters (fewer ads); arbitrage funnels run 'low'/'medium'.
    adsafe: process.env.NEXT_PUBLIC_AFS_ADSAFE || 'medium',
    ivt: false,
    // The results page that related-search terms link to (same approved host).
    resultsPageBaseUrl: `${window.location.origin}/search`,
    resultsPageQueryParam: 'q',
    ignoredPageParams: AFS_TRACKING_PARAMS,
    ...extra,
  };
  // Test mode: renders without counting impressions/clicks or paying. Safe for
  // verifying the integration (and avoids self-click policy issues). Flip off in prod.
  if (process.env.NEXT_PUBLIC_AFS_ADTEST === 'on') options.adtest = 'on';
  return options;
}

/** True when an AFS pubId is configured (only then do real units render). */
export function afsConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_AFS_PUB_ID);
}
