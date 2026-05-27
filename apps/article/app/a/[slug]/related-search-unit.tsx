'use client';

import { useEffect } from 'react';
import { afsConfigured, basePageOptions, runCsa } from '../../_afs/csa';
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
export function RelatedSearchUnit({ referrerAdCreative }: { referrerAdCreative?: string }) {
  const live = afsConfigured();

  useEffect(() => {
    if (!live) return;
    const pageOptions = basePageOptions({ relatedSearchTargeting: 'content' });
    // Required (since 2025-11-01) when traffic comes from a source you control (our FB ads).
    if (referrerAdCreative) pageOptions.referrerAdCreative = referrerAdCreative;
    runCsa('relatedsearch', pageOptions, { container: 'relatedsearches1', relatedSearches: 10 });
  }, [live, referrerAdCreative]);

  return (
    <aside className={styles.afs} aria-label="Related searches">
      <span className={styles.afsLabel}>Related searches</span>
      <div id="relatedsearches1" className={styles.afsSlot}>
        {!live && <p className={styles.afsPlaceholder}>Related searches appear here</p>}
      </div>
    </aside>
  );
}
