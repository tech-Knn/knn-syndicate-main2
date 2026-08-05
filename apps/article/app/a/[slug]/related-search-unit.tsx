'use client';

import { useEffect } from 'react';
import {
  AFS_TRACKING_PARAMS,
  afsAdLoadedCallback,
  afsConfigured,
  basePageOptions,
  runCsa,
  type SiteConfig,
} from '../../_afs/csa';
import styles from './article.module.css';

// Per-host RSOC unit-fill telemetry endpoint. Piggybacks on the same term-telemetry route
// used by /search — the beacon reports "unit:<host>" so the platform can distinguish page-
// level fills (chip strip present at all?) from per-term fills. Empty → inert.
const TERM_TELEMETRY_URL =
  process.env.NEXT_PUBLIC_TERM_TELEMETRY_URL ||
  (process.env.NEXT_PUBLIC_EVENTS_URL
    ? process.env.NEXT_PUBLIC_EVENTS_URL.replace(/\/api\/events\/?$/, '/api/telemetry/term')
    : '');

/**
 * Beacon whether the RSOC unit actually filled with related-search terms. Fires once from
 * `adLoadedCallback` (post ad-request, so it never delays the request) with a synthetic term key
 * `unit:<host>` — the reader filters that namespace out of per-term rankings but reads it directly
 * for the per-host unit-fill rate. Silent when telemetry is unconfigured or the host is unknown.
 */
function beaconUnitFill(host: string, filled: boolean): void {
  if (!TERM_TELEMETRY_URL || !host) return;
  try {
    const term = `unit:${host}`;
    const u =
      TERM_TELEMETRY_URL +
      (TERM_TELEMETRY_URL.indexOf('?') < 0 ? '?' : '&') +
      'term=' +
      encodeURIComponent(term) +
      '&event=render&filled=' +
      (filled ? '1' : '0');
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(u);
    } else {
      void fetch(u, { method: 'POST', keepalive: true, mode: 'no-cors' });
    }
  } catch {
    /* observe-only telemetry — never surface */
  }
}

/**
 * RSOC "Related Search on Content" unit for the article (content) page. Renders
 * search terms related to the article; clicking one navigates to our /search
 * results page (where the ads + revenue are).
 *
 * Compliance (Google Publisher Policies): a live monetized page must NEVER show an
 * empty or placeholder unit ("under construction / low-value content"). Related-search
 * terms only appear AFTER Google crawls the URL (~1h), so the container is mounted (CSA
 * needs it to render into) but the visible chrome — the "Related searches" label + the
 * bordered card — is revealed only once CSA reports the unit actually filled
 * (`adLoadedCallback` → `adsLoaded === true`). Until then the unit is zero-height/invisible.
 */
export function RelatedSearchUnit({
  referrerAdCreative,
  terms,
  txid,
  channel,
  token,
  site,
}: {
  referrerAdCreative?: string;
  terms?: string;
  /** The redirect click id — threaded onto /search so the conversion beacon can fire. */
  txid?: string;
  /** The offer's AFS channel — tags ad requests for per-offer revenue attribution (forwarded to /search as `cid`). */
  channel?: string;
  /** The signed cloak token (when present). Forwarded to /search so the results page is gated by the
   *  same proof and its URL leaks no plaintext AFS params either. Falls back to plaintext when absent. */
  token?: string;
  /** Per-host AFS config resolved server-side (pubId/style/adsafe). */
  site: SiteConfig;
}) {
  const live = afsConfigured(site);

  useEffect(() => {
    if (!live) return;
    // Carry the click id (+ ad creative + channel) onto the results page so /search can
    // attribute conversion + AFS revenue. CSA appends the query term as `q`.
    const rp = new URLSearchParams();
    if (token) {
      // Forward the signed token ONLY — it carries rc/ch/txid; /search decodes + gates on it, so the
      // results URL leaks no plaintext AFS params either.
      rp.set('t', token);
    } else {
      // Legacy / observe-without-token: forward plaintext params (today's behavior).
      if (txid) rp.set('txid', txid);
      if (referrerAdCreative) rp.set('rc', referrerAdCreative);
      // Forward the channel as `cid`, NOT `ch`: Google's results unit appends its own `ch=1`
      // click-telemetry param, so a `ch` here collides (two values → array → dropped) and the
      // offer's AFS revenue attribution is silently lost. Every competitor uses `cid` for this.
      if (channel) rp.set('cid', channel);
    }
    const resultsPageBaseUrl = `${window.location.origin}/search${rp.toString() ? `?${rp.toString()}` : ''}`;

    const pageOptions = basePageOptions(site, {
      relatedSearchTargeting: 'content',
      resultsPageBaseUrl,
      // On a content page the query params aren't the search query — ignore them too.
      ignoredPageParams: `${AFS_TRACKING_PARAMS},q,query`,
      // NOTE: personalizedAds + adPage were previously set here as speculative "may-help" fixes
      // (2026-08-04 commit). Live testing on partner-pub-6567805284657549 proved they suppressed
      // Google's serving instead — with them Google returned an empty ads array; without them
      // chips render (verified against /afs-test-relatedsearch.html which serves fine WITHOUT
      // these fields). Both intentionally omitted here. If Google's docs later mandate them, add
      // back conditionally per an env flag rather than unconditionally.
    });
    // Required (since 2025-11-01) when traffic comes from a source you control (our FB ads).
    if (referrerAdCreative) pageOptions.referrerAdCreative = referrerAdCreative;
    // Publisher-provided terms are only valid alongside referrerAdCreative (Google's rule).
    if (terms && referrerAdCreative) pageOptions.terms = terms;

    // Diagnostic URL overrides — help a super-admin isolate WHY Google returns zero chips.
    // Never sent by real traffic; only set explicitly on a hand-crafted test URL.
    const usp = new URLSearchParams(window.location.search);

    // Channel selection (defaults to the token's channel).
    //   ?nochannel=1               → drop channel entirely (test whether a bad DB channel
    //                                 is the cause of Google returning zero ads).
    //   ?testChannel=<value>       → override with an explicit channel string (paste in a
    //                                 real AdSense Custom Channel ID from the dashboard).
    // The token-decoded `channel` remains the default; overrides win when present.
    let effectiveChannel = channel;
    if (usp.get('nochannel') === '1') effectiveChannel = undefined;
    const testChannel = usp.get('testChannel');
    if (testChannel) effectiveChannel = testChannel;
    if (effectiveChannel) pageOptions.channel = effectiveChannel;

    // styleId override / removal — AdSense styles are TYPED (ads vs. relatedsearch); a style
    // created for one command silently returns zero when used with the other. If /search
    // ('ads' command) serves fine on the same pubId but article-page ('relatedsearch') does
    // not, the shared styleId is the smoking gun. Diagnostic overrides:
    //   ?nostyle=1              → drop styleId entirely; Google uses its own default RS style
    //   ?testStyle=<id>         → override with a specific RSOC-typed styleId (paste from AdSense)
    if (usp.get('nostyle') === '1') delete pageOptions.styleId;
    const testStyle = usp.get('testStyle');
    if (testStyle) pageOptions.styleId = testStyle;

    // `?adtest=1` forces Google's TEST-AD mode for this pageview only. Test ads never count
    // impressions/clicks and never pay, but they let a super-admin visually verify the widget
    // wiring end-to-end without waiting on a live-serving decision. Production traffic never
    // carries the flag; the domain's SiteConfig.adtest still applies when the URL param is absent.
    if (usp.get('adtest') === '1') {
      pageOptions.adtest = 'on';
    }

    // `?minimal=1` strips all optional params, leaving only what the working /afs-test-
    // relatedsearch.html static test sends. Diagnostic: if chips render with ?minimal=1 but
    // not without, one of the extras (terms/channel/personalizedAds/adPage/ignoredPageParams)
    // is what's blocking Google's live-serving decision on this account.
    if (usp.get('minimal') === '1') {
      delete pageOptions.personalizedAds;
      delete pageOptions.adPage;
      delete pageOptions.terms;
      delete pageOptions.channel;
      delete pageOptions.ignoredPageParams;
      delete pageOptions.ivt;
      delete pageOptions.resultsPageQueryParam;
    }

    // `?testRc=<phrase>` overrides the referrerAdCreative for this pageview. Google's rc quality
    // gate silently rejects brand-like/title-case values; use this to test a plain lowercase
    // search-intent phrase (e.g. `?testRc=best+used+cars+under+10000`). Also `?plainurl=1`
    // strips the token from resultsPageBaseUrl so it matches Google's canonical short-URL pattern.
    const testRc = usp.get('testRc');
    if (testRc) pageOptions.referrerAdCreative = testRc;
    if (usp.get('plainurl') === '1') {
      pageOptions.resultsPageBaseUrl = `${window.location.origin}/search`;
    }
    // TWO related-search blocks per Google's newer RSOC integration pattern. Some publisher
    // contracts / newer RSOC deployments expect at least two rsblocks (an above-the-fold band
    // and a lower band) — sending only one has been observed to cause Google to return zero
    // terms silently. Each block can independently fill; the aside chrome reveals when EITHER
    // fills. The `adLoadedCallback` receives the container name so per-block state is
    // observable in telemetry.
    const rsblock1 = {
      container: 'relatedsearches1',
      // Send BOTH `relatedSearches` (legacy) and `number` (newer RSOC integrations) so whichever
      // Google's ads.js reads is populated. 5 chips per block matches the newer RSOC pattern.
      relatedSearches: 5,
      number: 5,
      adLoadedCallback: (containerName: string, adsLoaded: boolean) => {
        afsAdLoadedCallback(containerName, adsLoaded);
        // Per-host RSOC unit-fill telemetry (observe-only). Fires per block per page-view once
        // CSA resolves the request — distinguishes "widget fired but Google returned zero" from
        // "widget never fired". Diagnostic for $0-revenue campaigns.
        beaconUnitFill(window.location.host, adsLoaded);
      },
    };
    const rsblock2 = {
      container: 'relatedsearches2',
      relatedSearches: 5,
      number: 5,
      adLoadedCallback: (containerName: string, adsLoaded: boolean) => {
        afsAdLoadedCallback(containerName, adsLoaded);
      },
    };
    runCsa('relatedsearch', pageOptions, rsblock1, rsblock2);
  }, [live, referrerAdCreative, terms, txid, channel, token, site]);

  // No AFS account for this host → don't render a unit at all (no placeholder, ever).
  if (!live) return null;

  // The container (#relatedsearches1) is always mounted so CSA can render into it. We add NO
  // label/border of our own — Google's related-search unit renders its own "Related searches"
  // header (a duplicate label reads as placeholder/broken). The wrapper only adds spacing, and
  // only once the unit actually fills (`adsLoaded`), so an uncrawled/empty unit takes zero space.
  //
  // a11y: the `aria-label` is applied ONLY once the unit is actually filled — labelling an
  // empty (uncrawled / nothing-served) container would announce a region that has no content.
  // We deliberately do NOT set `aria-hidden` here: this wrapper is an ancestor of the CSA
  // container, so `aria-hidden` would suppress the real served related-search links from
  // assistive tech. Before fill the unit is zero-footprint via `.afsPending` (no injected
  // children yet), so it needs no `aria-hidden` to stay out of the way.
  return (
    <aside
      className={styles.afs}
      aria-label="Related searches"
    >
      {/* rsblock1's container. rsblock2's container (#relatedsearches2) is rendered separately
          in apps/article/app/a/[slug]/page.tsx after the SECOND H2 heading — placing the second
          chip strip mid-article for better user attention on longer reads. The single
          `_googCsa('relatedsearch', pageOptions, rsblock1, rsblock2)` call above targets BOTH
          containers by id; as long as both divs exist in the DOM at useEffect time (they do —
          both are server-rendered), CSA fills each independently.
          Externally-managed pattern (`dangerouslySetInnerHTML={{__html:''}}` +
          `suppressHydrationWarning`) so React never wipes ads.js's injected iframe on re-render.
          ALWAYS-VISIBLE: previously the aside stayed collapsed (afsPending) until adLoadedCallback
          reported adsLoaded=true, but Google was observed to inject chip content WITHOUT firing
          the callback consistently — chips ended up in the DOM but hidden. Always render visible;
          empty spacer when Google returns nothing is a fine trade-off for guaranteed visibility. */}
      <div id="relatedsearches1" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: '' }} />
    </aside>
  );
}
