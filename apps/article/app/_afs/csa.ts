/**
 * Google Custom Search Ads (CSA) loader — the runtime half of AdSense for Search
 * / RSOC. Mirrors the exact bootstrap from the AdSense code generator:
 *   (function(g,o){g[o]=g[o]||function(){(g[o].q=g[o].q||[]).push(arguments)},
 *    g[o].t=1*new Date})(window,'_googCsa');
 * then `_googCsa(command, pageOptions, ...blocks)`, with `ads.js` loaded async
 * (it drains the queue). Client-only — call from a useEffect.
 */
type GoogCsa = ((command: string, pageOptions: Record<string, unknown>, ...blocks: Record<string, unknown>[]) => void) & {
  q?: unknown[];
  t?: number;
};

const ADS_JS = 'https://www.google.com/adsense/search/ads.js';
const ADS_JS_ID = 'google-adsense-search';

/** Queue a CSA command and ensure ads.js is loaded to process it. */
export function runCsa(
  command: 'ads' | 'relatedsearch',
  pageOptions: Record<string, unknown>,
  ...blocks: Record<string, unknown>[]
): void {
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
  w._googCsa(command, pageOptions, ...blocks);

  if (!document.getElementById(ADS_JS_ID)) {
    const script = document.createElement('script');
    script.id = ADS_JS_ID;
    script.async = true;
    script.src = ADS_JS;
    document.head.appendChild(script);
  }
}

/** Shared page-level options from env (build-time NEXT_PUBLIC_*) + the results page URL. */
export function basePageOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const pubId = process.env.NEXT_PUBLIC_AFS_PUB_ID ?? '';
  const styleId = process.env.NEXT_PUBLIC_AFS_STYLE_ID ?? '';
  const options: Record<string, unknown> = {
    pubId,
    styleId,
    // The results page that the related-search terms link to (same approved host).
    resultsPageBaseUrl: `${window.location.origin}/search`,
    resultsPageQueryParam: 'query',
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
