'use client';

import { useEffect, useState } from 'react';
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
  const [filled, setFilled] = useState(false);

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
      // Google's RSOC treats an OMITTED `personalizedAds` as "unspecified" and, under
      // GDPR-style default-deny, may return zero related-search terms (silent). Set it
      // explicitly true (equivalent to a valid CMP consent-signal) so RSOC serves — the
      // article app itself is not a consent surface, so publishers control this upstream
      // via their own CMP; this is the safe default for pages that already gated consent.
      personalizedAds: true,
      // Explicit page number — some RSOC deployments have observed empty responses when omitted.
      adPage: 1,
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
    runCsa('relatedsearch', pageOptions, {
      container: 'relatedsearches1',
      // ~6 (not 10): matches Google's official RSOC examples and keeps the unit a supplement
      // to the article rather than the page's focus (a 10-chip block dominates the content).
      // Send BOTH `relatedSearches` (legacy) and `number` (newer RSOC integrations) so whichever
      // Google's ads.js reads is populated.
      relatedSearches: 6,
      number: 6,
      adLoadedCallback: (containerName: string, adsLoaded: boolean) => {
        afsAdLoadedCallback(containerName, adsLoaded);
        // Reveal the unit's chrome only when it actually served terms.
        if (adsLoaded) setFilled(true);
        // Per-host RSOC unit-fill telemetry (observe-only). Fires once per page-view once CSA
        // resolves the request — the ONLY place we can distinguish "widget fired but Google
        // returned zero terms" from "widget never fired". Diagnostic for $0-revenue campaigns.
        beaconUnitFill(window.location.host, adsLoaded);
      },
    });
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
      className={filled ? styles.afs : styles.afsPending}
      {...(filled ? { 'aria-label': 'Related searches' } : {})}
    >
      {/* Externally-managed by Google CSA: ads.js injects the related-search <iframe> into this
          container, so React must treat its contents as opaque — `dangerouslySetInnerHTML={{__html:''}}`
          (suppressHydrationWarning alone covers only attrs/text, not child nodes). Without this the
          server-empty vs client-injected div mismatches on hydration (#418) and React can wipe the
          unit when `filled` toggles a re-render. Mirrors /search's #afscontainer1. */}
      <div id="relatedsearches1" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: '' }} />
    </aside>
  );
}
