'use client';

import { useEffect } from 'react';
import { afsAdLoadedCallback, afsConfigured, basePageOptions, runCsa, type SiteConfig } from '../_afs/csa';
import styles from './search.module.css';

/**
 * RSOC results page ads unit. Matches the AdSense-generated Search-page snippet:
 * `_googCsa('ads', { pubId, query, styleId, adsafe: 'high', ... },
 *   { container: 'afscontainer1' }, { container: 'relatedsearches1', relatedSearches: 10 })`.
 * Ads render immediately for a given query (no crawl needed) — this is where the
 * monetization happens.
 */
export function SearchAdsUnit({
  query,
  referrerAdCreative,
  channel,
  site,
}: {
  query: string;
  referrerAdCreative?: string;
  /** The offer's AFS channel (`ch`) — tags the ad request for per-offer revenue attribution. */
  channel?: string;
  /** Per-host AFS config resolved server-side (pubId/style/adsafe). */
  site: SiteConfig;
}) {
  const live = afsConfigured(site);

  useEffect(() => {
    if (!live || !query) return;
    // linkTarget '_blank' opens ads in a new tab, keeping the results page open.
    const pageOptions = basePageOptions(site, { query, linkTarget: '_blank' });
    if (referrerAdCreative) pageOptions.referrerAdCreative = referrerAdCreative;
    // The AdSense custom channel (per-offer attribution) — this is where ads earn.
    if (channel) pageOptions.channel = channel;
    runCsa(
      'ads',
      pageOptions,
      { container: 'afscontainer1', adLoadedCallback: afsAdLoadedCallback },
      { container: 'relatedsearches1', relatedSearches: 10, adLoadedCallback: afsAdLoadedCallback },
    );
  }, [live, query, referrerAdCreative, channel, site]);

  // No AFS account for this host → render nothing (never a placeholder on a live page).
  if (!live) return null;

  return (
    <>
      <div id="afscontainer1" className={styles.ads} />
      <div id="relatedsearches1" className={styles.related} />
    </>
  );
}
