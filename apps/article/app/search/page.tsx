import type { Metadata } from 'next';
import { resolveSiteConfig } from '../_afs/site-config';
import { ConversionTracker } from './conversion-tracker';
import { SearchAdsUnit } from './search-ads-unit';
import styles from './search.module.css';

export const metadata: Metadata = { title: 'Search results', robots: { index: false } };

function str(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * RSOC results page. Related-search terms on the article (content) page link here
 * with the query in the `query` param (resultsPageQueryParam). This page renders
 * the Google ads unit for that query.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const site = await resolveSiteConfig();
  // `q` is the default CSA results param (resultsPageQueryParam); accept `query` too.
  const query = str(sp.q) || str(sp.query);
  const referrerAdCreative = str(sp.rc) || undefined;
  // The offer's AFS channel (per-offer attribution) — forwarded here from the content page.
  const channel = str(sp.ch) || undefined;
  // Conversion attribution: the redirect threads the click id (txid) + optional
  // value (cv) / currency (ccy) here via the content page's results-page URL.
  const clickId = str(sp.txid) || undefined;
  const value = str(sp.cv) || undefined;
  const currency = str(sp.ccy) || undefined;

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <span className={styles.brand}>10 Lines About</span>
        {query && (
          <h1 className={styles.query}>
            Results for <strong>{query}</strong>
          </h1>
        )}
      </div>
      <SearchAdsUnit query={query} referrerAdCreative={referrerAdCreative} channel={channel} site={site} />
      <ConversionTracker clickId={clickId} value={value} currency={currency} />
    </main>
  );
}
