'use client';

import { useEffect } from 'react';
import styles from './article.module.css';

/** Google CSA queue function (`_googCsa`) installed before `ads.js` loads. */
type GoogCsa = ((command: string, pageOptions: Record<string, unknown>, adBlock: Record<string, unknown>) => void) & {
  q?: unknown[];
  t?: number;
};

const CSA_SRC = 'https://www.google.com/adsense/search/ads.js';
const CONTAINER_ID = 'afs-ads';

/**
 * AdSense for Search / Custom Search Ads (AFS/CSA) slot.
 *
 * AFS ads ONLY serve on Google-approved domains, so this renders the real CSA
 * widget when `pubId` is configured (`NEXT_PUBLIC_AFS_PUB_ID`) and shows a
 * labeled placeholder everywhere else (local dev / unapproved hosts). The
 * `query` (search keywords), `channel` (per-campaign → revenue attribution,
 * D7/D8) and `styleId` come from the redirect URL.
 */
export function AfsWidget({
  pubId,
  query,
  channel,
  styleId,
}: {
  pubId: string;
  query: string;
  channel: string;
  styleId: string;
}) {
  const live = Boolean(pubId);

  useEffect(() => {
    if (!live || !query) return; // no ads without an approved pubId + a search query

    const w = window as unknown as { _googCsa?: GoogCsa };
    if (!w._googCsa) {
      const queue: unknown[] = [];
      const stub = ((...args: unknown[]) => {
        queue.push(args);
      }) as unknown as GoogCsa;
      stub.q = queue;
      stub.t = Date.now();
      w._googCsa = stub;
    }

    const pageOptions: Record<string, unknown> = { pubId, query, hl: 'en', adsafe: 'high' };
    if (styleId) pageOptions.styleId = styleId;
    if (channel) pageOptions.channel = channel;
    const adBlock: Record<string, unknown> = { container: CONTAINER_ID, maxTop: 4, width: 'auto' };
    w._googCsa('ads', pageOptions, adBlock);

    if (!document.getElementById('google-csa-ads')) {
      const script = document.createElement('script');
      script.id = 'google-csa-ads';
      script.async = true;
      script.src = CSA_SRC;
      document.head.appendChild(script);
    }
  }, [live, pubId, query, channel, styleId]);

  return (
    <aside className={styles.afs} aria-label="Sponsored results">
      <span className={styles.afsLabel}>Sponsored results</span>
      <div
        id={CONTAINER_ID}
        className={styles.afsSlot}
        data-query={query}
        data-channel={channel}
        data-style-id={styleId}
      >
        {!live && (
          <p className={styles.afsPlaceholder}>
            {query ? `Related results for “${query}”` : 'Related sponsored results'}
          </p>
        )}
      </div>
    </aside>
  );
}
