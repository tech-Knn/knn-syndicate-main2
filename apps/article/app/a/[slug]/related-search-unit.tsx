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
  site,
}: {
  referrerAdCreative?: string;
  terms?: string;
  /** The redirect click id — threaded onto /search so the conversion beacon can fire. */
  txid?: string;
  /** The offer's AFS channel (`ch`) — tags ad requests for per-offer revenue attribution. */
  channel?: string;
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
    if (txid) rp.set('txid', txid);
    if (referrerAdCreative) rp.set('rc', referrerAdCreative);
    if (channel) rp.set('ch', channel);
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
      relatedSearches: 10,
      adLoadedCallback: (containerName: string, adsLoaded: boolean) => {
        afsAdLoadedCallback(containerName, adsLoaded);
        // Reveal the unit's chrome only when it actually served terms.
        if (adsLoaded) setFilled(true);
      },
    });
  }, [live, referrerAdCreative, terms, txid, channel, site]);

  // No AFS account for this host → don't render a unit at all (no placeholder, ever).
  if (!live) return null;

  // The container (#relatedsearches1) is always mounted so CSA can render into it. We add NO
  // label/border of our own — Google's related-search unit renders its own "Related searches"
  // header (a duplicate label reads as placeholder/broken). The wrapper only adds spacing, and
  // only once the unit actually fills (`adsLoaded`), so an uncrawled/empty unit takes zero space.
  return (
    <aside className={filled ? styles.afs : styles.afsPending} aria-label="Related searches" aria-hidden={!filled}>
      <div id="relatedsearches1" />
    </aside>
  );
}
