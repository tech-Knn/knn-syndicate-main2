import { afsConfigured, AFS_TRACKING_PARAMS, type SiteConfig } from '../../_afs/csa';
import styles from './article.module.css';

/**
 * RSOC "Related Search on Content" unit for the article (money) page. Server-rendered with an
 * INLINE bootstrap script — identical latency pattern to `/search/search-ads.tsx`. The ad
 * request fires during HTML parse (before React hydrates), which is the whole point:
 *
 *   OLD path (Sep 2026 and earlier): `'use client'` + `useEffect(...)` — chips took 1–3s to
 *   appear on mobile because they waited for React hydration → append <script async> → download
 *   ads.js → execute → request → paint. Measured 43–81% of paid FB visitors bounced during
 *   that window (0 conversions on active India campaigns; user reported keywords "loading
 *   after 1-3 seconds" from an Ad Manager preview click, 2026-09-24).
 *
 *   NEW path (this file): SSR emits the container + an inline bootstrap that runs during HTML
 *   parse. `ads.js` is `preload`ed in resource-hints.tsx so it's already in the browser cache
 *   by the time the inline script appends the <script> tag. Chip render moves from ~1–3s to
 *   ~200–400ms — Google's preconnect (already set) covers the TLS cost.
 *
 * Compliance (Google Publisher Policies): a live monetized page must NEVER show an empty
 * placeholder unit. The `<aside>` chrome is unconditionally rendered but CSS (`.afs`) reserves
 * no visual space until Google's ads.js injects real chip iframes into the container — an
 * uncrawled / empty unit stays zero-footprint.
 *
 * Container layout: `#relatedsearches1` is placed here (above the article body); `#relatedsearches2`
 * is placed in `page.tsx` AFTER the second H2 for a mid-article second strip. The single
 * `_googCsa('relatedsearch', po, rsblock1, rsblock2)` call targets both by id.
 */

// Per-host RSOC unit-fill telemetry endpoint. Same telemetry sink /search uses.
const TERM_TELEMETRY_URL =
  process.env.NEXT_PUBLIC_TERM_TELEMETRY_URL ||
  (process.env.NEXT_PUBLIC_EVENTS_URL
    ? process.env.NEXT_PUBLIC_EVENTS_URL.replace(/\/api\/events\/?$/, '/api/telemetry/term')
    : '');

// Chars that must be escaped before embedding JSON in an inline <script>. Same rules as the
// safeJson in search-ads.tsx. U+2028/U+2029 are illegal raw in a JS string literal.
const UNSAFE_SCRIPT_CHARS = new RegExp('[<>&\\u2028\\u2029]', 'g');

/** Serialize a value for safe embedding in an inline <script>. Server-embedded strings
 *  (channel/rc/terms/txid) are the XSS boundary; each dangerous char becomes `\\uXXXX`. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    UNSAFE_SCRIPT_CHARS,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

export function RelatedSearchUnit({
  referrerAdCreative,
  terms,
  txid,
  channel,
  site,
}: {
  referrerAdCreative?: string;
  /** Comma-separated publisher terms (high-CPC list) — sent as `terms` in pageOptions. */
  terms?: string;
  /** The redirect click id — carried on the /search URL fragment so the conversion beacon can fire. */
  txid?: string;
  /** The offer's AFS channel — tagged on ad requests for per-offer revenue attribution and
   *  forwarded to /search via URL fragment + cookie. */
  channel?: string;
  /** Per-host AFS config resolved server-side (pubId/style/adsafe). */
  site: SiteConfig;
}) {
  if (!afsConfigured(site)) return null;

  // The core page-level options baked at SSR time. `resultsPageBaseUrl` is left out here
  // because it depends on `window.location.origin` (per-host) — the inline script assembles it.
  const basePo: Record<string, unknown> = {
    pubId: site.pubId,
    styleId: site.styleId,
    hl: 'en',
    adsafe: site.adsafe || 'medium',
    ivt: false,
    relatedSearchTargeting: 'content',
    resultsPageQueryParam: 'q',
    ignoredPageParams: `${AFS_TRACKING_PARAMS},q,query`,
  };
  if (referrerAdCreative) basePo.referrerAdCreative = referrerAdCreative;
  if (channel) basePo.channel = channel;
  if (terms) basePo.terms = terms;
  if (site.adtest) basePo.adtest = 'on';

  // Fragment (#c=&r=&x=) that resultsPageBaseUrl carries: channel/rc/txid recovery signal for
  // /search. Fragment (not query) because Google's RSOC rejects query params on this URL
  // (verified 2026-08-05) but does NOT reject fragments — and the fragment travels intact
  // through Google's iframe chip-click navigation into /search where the client-side
  // bootstrap reads it back.
  const hashParts: string[] = [];
  if (channel) hashParts.push(`c=${encodeURIComponent(channel)}`);
  if (referrerAdCreative) hashParts.push(`r=${encodeURIComponent(referrerAdCreative)}`);
  if (txid) hashParts.push(`x=${encodeURIComponent(txid)}`);
  const resultsHash = hashParts.length ? '#' + hashParts.join('&') : '';

  // The inline bootstrap. Same shape as search-ads.tsx: define the _googCsa queue stub, apply
  // client-only overrides (URL params + resultsPageBaseUrl origin), fire the relatedsearch
  // command, inject ads.js. Runs during HTML parse.
  const bootstrap =
    // 1. Queue stub — captures the command until ads.js drains it.
    `(function(g,o){g[o]=g[o]||function(){(g[o].q=g[o].q||[]).push(arguments)};g[o].t=1*new Date})(window,'_googCsa');` +
    // 2. Assemble pageOptions from the server-embedded base + client-only bits.
    `var po=${safeJson(basePo)};` +
    `po.resultsPageBaseUrl=window.location.origin+'/search'+${safeJson(resultsHash)};` +
    // 3. Diagnostic URL param overrides (super-admin tools, unused by real traffic). Match
    //    the historical set from the old useEffect path so pre-existing debug links keep
    //    working: ?withchannel=<v>, ?testChannel=<v>, ?withterms=<v>, ?nostyle=1,
    //    ?testStyle=<v>, ?adtest=1, ?minimal=1, ?testRc=<v>, ?plainurl=1,
    //    ?nortstargeting=1 (2026-09-24: probe whether removing relatedSearchTargeting:'content'
    //    lets Google actually use the publisher `terms` we send — currently observed to be
    //    ignored because 'content' targeting overrides them. Safe: URL-flag-only, real traffic
    //    keeps sending the field until we see evidence one way or the other).
    `try{var _u=new URLSearchParams(location.search);` +
    `var _c=_u.get('withchannel')||_u.get('testChannel');if(_c){po.channel=_c;}` +
    `var _t=_u.get('withterms');if(_t&&_t!=='1'){po.terms=_t;}` +
    `if(_u.get('nostyle')==='1'){delete po.styleId;}` +
    `var _s=_u.get('testStyle');if(_s){po.styleId=_s;}` +
    `if(_u.get('adtest')==='1'){po.adtest='on';}` +
    `if(_u.get('nortstargeting')==='1'){delete po.relatedSearchTargeting;}` +
    `if(_u.get('minimal')==='1'){delete po.terms;delete po.channel;delete po.ignoredPageParams;delete po.ivt;delete po.resultsPageQueryParam;delete po.relatedSearchTargeting;}` +
    `var _r=_u.get('testRc');if(_r){po.referrerAdCreative=_r;}` +
    `if(_u.get('plainurl')==='1'){po.resultsPageBaseUrl=window.location.origin+'/search';}` +
    `}catch(e){}` +
    // 4. Some AdSense custom-style templates read window.pageOptions / PageOptions.
    `window.pageOptions=po;window.PageOptions=po;` +
    // 5. Per-host unit-fill telemetry — same beacon as the old client component.
    `var TT=${safeJson(TERM_TELEMETRY_URL)};` +
    `function ttUnit(f){if(!TT)return;try{var u=TT+(TT.indexOf('?')<0?'?':'&')+'term='+encodeURIComponent('unit:'+location.host)+'&event=render&filled='+(f?1:0);navigator.sendBeacon?navigator.sendBeacon(u):fetch(u,{method:'POST',keepalive:!0,mode:'no-cors'})}catch(e){}}` +
    // 6. Two rsblocks (per Google's newer RSOC pattern; single block has been observed to
    //    silently return zero terms). Both send legacy `relatedSearches` and newer `number`
    //    so whichever ads.js reads is populated.
    `var b1={container:'relatedsearches1',relatedSearches:5,number:5,adLoadedCallback:function(c,l){ttUnit(l)}};` +
    `var b2={container:'relatedsearches2',relatedSearches:5,number:5,adLoadedCallback:function(c,l){}};` +
    `_googCsa('relatedsearch',po,b1,b2);` +
    // 7. Load ads.js. Preloaded in resource-hints.tsx so the browser already has it in cache
    //    on modern browsers — this append is essentially free.
    `var s=document.createElement('script');s.async=!0;s.src='https://www.google.com/adsense/search/ads.js';document.head.appendChild(s);` +
    // 8. bfcache re-fire — user navigates chip → /search → hits Back → article restored from
    //    bfcache. Without this the old CSA iframe is stale and chips are gone. We clear both
    //    containers and re-fire the command so chips render again for a second click.
    `window.addEventListener('pageshow',function(e){if(!e.persisted)return;var c1=document.getElementById('relatedsearches1'),c2=document.getElementById('relatedsearches2');if(c1)c1.innerHTML='';if(c2)c2.innerHTML='';_googCsa('relatedsearch',po,b1,b2);});`;

  return (
    <aside className={styles.afs} aria-label="Related searches">
      {/* Container first so it exists in the DOM before the bootstrap runs. ads.js injects
          <iframe>s during parse (pre-hydration); externally-managed to React
          (dangerouslySetInnerHTML + suppressHydrationWarning) so hydration never wipes it. */}
      <div id="relatedsearches1" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: '' }} />
      <script dangerouslySetInnerHTML={{ __html: bootstrap }} />
    </aside>
  );
}
