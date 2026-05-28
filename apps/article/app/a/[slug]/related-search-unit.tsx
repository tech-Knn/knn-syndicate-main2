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

/**
 * RSOC "Related Search on Content" unit for the article (content) page. Renders
 * search terms related to the article; clicking one navigates to our /search
 * results page (where the ads + revenue are). Matches the AdSense-generated
 * Content-page snippet: `_googCsa('relatedsearch', { relatedSearchTargeting:
 * 'content', ... }, { container: 'relatedsearches1', relatedSearches: 10 })`.
 *
 * NOTE: terms only appear after Google has crawled this URL (~1h after first view).
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
      adLoadedCallback: afsAdLoadedCallback,
    });
  }, [live, referrerAdCreative, terms, txid, channel, site]);

  return (
    <aside className={styles.afs} aria-label="Related searches">
      <span className={styles.afsLabel}>Related searches</span>
      <div id="relatedsearches1" className={styles.afsSlot}>
        {!live && <p className={styles.afsPlaceholder}>Related searches appear here</p>}
      </div>
    </aside>
  );
}
