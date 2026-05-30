import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { resolveSiteConfig, resolveSiteName } from '../_afs/site-config';
import { ConversionTracker } from './conversion-tracker';
import { SearchAds } from './search-ads';
import { fetchWebResults, WebResults } from './web-results';
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
  const host = (await headers()).get('host') ?? '';
  // Resolve config, the per-host brand, and the organic Web results together. The articles
  // fetch is the SAME cached request <WebResults> renders from (Next memoizes identical
  // fetches within a render), so it's a cache hit — not an extra DB round-trip on the hot path.
  // We thread the result COUNT into the ads decision below: Google's Search-ads policy requires
  // ads ≤ search results, so with zero organic results we must show zero ads.
  const [site, siteName, articles] = await Promise.all([
    resolveSiteConfig(),
    resolveSiteName(),
    fetchWebResults(host),
  ]);
  // `q` is the default CSA results param (resultsPageQueryParam); accept `query` too.
  const query = str(sp.q) || str(sp.query);
  const referrerAdCreative = str(sp.rc) || undefined;
  // The offer's AFS channel (per-offer attribution) — forwarded from the content page as `cid`,
  // NOT `ch`: Google appends its own `ch=1` click-telemetry param to this results URL, so reading
  // `ch` would get an array (ours + Google's) → dropped → silently lost revenue attribution.
  const channel = str(sp.cid) || undefined;
  // Conversion attribution: the redirect threads the click id (txid) + optional
  // value (cv) / currency (ccy) here via the content page's results-page URL.
  const clickId = str(sp.txid) || undefined;
  const value = str(sp.cv) || undefined;
  const currency = str(sp.ccy) || undefined;

  return (
    <>
      <a className="skipLink" href="#main-content">
        Skip to content
      </a>
      <main id="main-content" className={styles.page}>
        <div className={styles.header}>
          <a className={styles.brand} href="/">
            {siteName}
          </a>
          {query && (
            <h1 className={styles.query}>
              Results for <strong>{query}</strong>
            </h1>
          )}
        </div>
        {/* Ads supplement REAL search results: capped at (and suppressed without) the organic
            Web-result count below — Google's Search-ads policy (ads ≤ results). */}
        <SearchAds
          query={query}
          referrerAdCreative={referrerAdCreative}
          channel={channel}
          site={site}
          maxAds={articles.length}
        />
        <WebResults host={host} articles={articles} />
        <ConversionTracker clickId={clickId} value={value} currency={currency} />
      </main>
    </>
  );
}
