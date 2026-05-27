'use client';

import { useEffect } from 'react';
import { afsConfigured, basePageOptions, runCsa } from '../_afs/csa';
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
}: {
  query: string;
  referrerAdCreative?: string;
}) {
  const live = afsConfigured();

  useEffect(() => {
    if (!live || !query) return;
    const pageOptions = basePageOptions({ query, adsafe: 'high' });
    if (referrerAdCreative) pageOptions.referrerAdCreative = referrerAdCreative;
    runCsa(
      'ads',
      pageOptions,
      { container: 'afscontainer1' },
      { container: 'relatedsearches1', relatedSearches: 10 },
    );
  }, [live, query, referrerAdCreative]);

  return (
    <>
      <div id="afscontainer1" className={styles.ads}>
        {!live && <p className={styles.placeholder}>Sponsored results for “{query}”</p>}
      </div>
      <div id="relatedsearches1" className={styles.related} />
    </>
  );
}
