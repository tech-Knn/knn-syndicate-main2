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
    });
    // Required (since 2025-11-01) when traffic comes from a source you control (our FB ads).
    if (referrerAdCreative) pageOptions.referrerAdCreative = referrerAdCreative;
    // Publisher-provided terms are only valid alongside referrerAdCreative (Google's rule).
    if (terms && referrerAdCreative) pageOptions.terms = terms;
    // The AdSense custom channel (per-offer attribution) — tags the ad request.
    if (channel) pageOptions.channel = channel;
    runCsa('relatedsearch', pageOptions, {
      container: 'relatedsearches1',
      // ~6 (not 10): matches Google's official RSOC examples and keeps the unit a supplement
      // to the article rather than the page's focus (a 10-chip block dominates the content).
      relatedSearches: 6,
      adLoadedCallback: (containerName: string, adsLoaded: boolean) => {
        afsAdLoadedCallback(containerName, adsLoaded);
        // Reveal the unit's chrome only when it actually served terms.
        if (adsLoaded) setFilled(true);
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
