import { afsConfigured, type SiteConfig } from '../_afs/csa';
import styles from './search.module.css';

/**
 * RSOC results-page ads — the single most latency-sensitive surface on the platform.
 * Every millisecond before the ad request fires is lost revenue, so this is a SERVER
 * component that fires `_googCsa('ads', …)` from an INLINE script during HTML parse —
 * exactly like the official AdSense search snippet and the competitor funnels.
 *
 * Why not a client `useEffect` (the old path)? That waits for ~100 kB of Next/React to
 * download + hydrate before the ad request even starts — hundreds of ms of dead time on
 * the money page. Here the request starts at first parse, with Google's origins already
 * preconnected (see the root layout), so ads render essentially at first paint. React is
 * not on the critical path at all.
 */

// Chars that must be escaped before embedding JSON in an inline <script>: `<`, `>`, `&`
// could break out of the script element / be reinterpreted by the HTML parser, and the
// U+2028 / U+2029 line separators are valid JSON but illegal raw in a JS string literal.
// The matcher is built from a STRING (not a regex literal) so the source stays pure ASCII
// — a raw U+2028/U+2029 is itself a line terminator and illegal inside a regex literal.
const UNSAFE_SCRIPT_CHARS = new RegExp('[<>&\\u2028\\u2029]', 'g');

/** Serialize a value for safe embedding in an inline <script>. `query`/`rc`/`channel`
 *  come from the URL, so this is the XSS boundary. Each dangerous char becomes its
 *  `\\uXXXX` escape, which JSON.parse / the JS reader restore identically. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    UNSAFE_SCRIPT_CHARS,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

export function SearchAds({
  query,
  referrerAdCreative,
  channel,
  site,
  maxAds,
}: {
  query: string;
  referrerAdCreative?: string;
  /** The offer's AFS channel (per-offer attribution) — tags the ad request. */
  channel?: string;
  /** Per-host AFS config resolved server-side (pubId/style/adsafe). */
  site: SiteConfig;
  /**
   * Hard cap on the number of ads, derived from the actual count of organic Web results
   * on this page. Google's Search-ads policy requires ads ≤ search results, so the page
   * must never show ads with no results. `0` (no organic results / fetch error) → render
   * NOTHING, so the ad unit can't appear above an empty results list.
   */
  maxAds: number;
}) {
  // No AFS account for this host, no query, or no organic results to supplement →
  // render nothing (never ads without results, never an empty unit).
  if (!afsConfigured(site) || !query || maxAds < 1) return null;

  // Ads are capped at the organic-result count (≤5 by design), so ads ≤ results always.
  const number = Math.min(maxAds, 5);

  // Page-level options Google needs to serve ads for this query. Mirrors basePageOptions
  // but built server-side; resultsPageBaseUrl is origin-dependent so it's set in the inline
  // script from window.location.origin (the only place the browser origin is known).
  const pageOptions: Record<string, unknown> = {
    pubId: site.pubId,
    styleId: site.styleId,
    query,
    hl: 'en',
    adsafe: site.adsafe || 'medium',
    ivt: false,
    // Open ads in a new tab so the results page stays put.
    linkTarget: '_blank',
    // NB: no ignoredPageParams here — that's a content-page option (CSA rejects it on the
    // 'ads' command, where the query is explicit). It only belongs on the relatedsearch unit.
    resultsPageQueryParam: 'q',
  };
  // Required (since 2025-11-01) when traffic comes from a source we control (our FB ads).
  if (referrerAdCreative) pageOptions.referrerAdCreative = referrerAdCreative;
  // The AdSense custom channel (per-offer attribution) — this is where ads earn.
  if (channel) pageOptions.channel = channel;
  // Test mode (never counts impressions/clicks): off in prod.
  if (site.adtest) pageOptions.adtest = 'on';

  // The inline bootstrap: define the _googCsa queue stub, push the ads call, then inject
  // ads.js (which drains the queue). Identical bootstrap to the AdSense code generator,
  // but emitted server-side so it runs during parse instead of after hydration.
  const bootstrap =
    `(function(g,o){g[o]=g[o]||function(){(g[o].q=g[o].q||[]).push(arguments)};g[o].t=1*new Date})(window,'_googCsa');` +
    `var po=${safeJson(pageOptions)};po.resultsPageBaseUrl=window.location.origin+'/search';` +
    // Ads only (no relatedSearchBlock — the organic <WebResults> below ARE the results the ads
    // supplement). `number` is capped to the ACTUAL organic Web-result count (≤5), so ads ≤
    // results (Google policy: number of ads ≤ number of search results). Google may serve fewer.
    `_googCsa('ads',po,{container:'afscontainer1',number:${number}});` +
    `var s=document.createElement('script');s.async=!0;s.src='https://www.google.com/adsense/search/ads.js';document.head.appendChild(s);`;

  return (
    <>
      {/* Container first so it exists in the DOM before the bootstrap (below) runs.
          ads.js injects ad <iframe>s into it DURING parse (before hydration). React must not
          reconcile (and wipe) that injected content, so the container is marked as externally-
          managed via dangerouslySetInnerHTML={{__html:''}} — React then treats its contents as
          opaque and never recurses into them on hydration. (suppressHydrationWarning alone is
          NOT enough: it covers an element's own attrs/text, not child nodes.) */}
      <div id="afscontainer1" className={styles.ads} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: '' }} />
      {/* Trusted bootstrap; the only dynamic values (query/rc/channel) are safeJson-escaped above. */}
      <script dangerouslySetInnerHTML={{ __html: bootstrap }} />
    </>
  );
}
