import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { resolveCloakGate } from '../_afs/cloak-gate';
import { resolveSiteConfig, resolveSiteName } from '../_afs/site-config';
import { ConversionTracker } from '../funnel-beacons';
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
  // `q` is the default CSA results param (resultsPageQueryParam); accept `query` too. The query is
  // the visitor's clicked term — NOT a monetization secret — so it stays a normal param.
  const query = str(sp.q) || str(sp.query);
  // Cloak gate: a real click reaches /search carrying the forwarded signed token (`?t=`) — rc/ch/txid
  // are decoded from it (no plaintext on the results URL either). The results page always renders its
  // ads (Google's crawler must see them to serve); the gate only chooses the param source: the token
  // if valid, else the plaintext `rc`/`cid`/`txid` params. Cloaking is upstream at the go.* Worker.
  const gate = await resolveCloakGate(sp, Date.now());
  const referrerAdCreative = gate.params.rc;
  // The offer's AFS channel (per-offer attribution). Sources, in priority order:
  //   1. Same-origin cookie `_rsoc_ch` set by the article page (AUTHORITATIVE — our value)
  //   2. Token / URL params via cloak-gate (legacy path)
  //
  // Cookie MUST be first: Google's ads.js on /search often appends its own `?ch=1` telemetry
  // param after ads render, which cloak-gate would otherwise treat as "channel=1" and clobber
  // our real channel. The cookie set on the article page is our definitive source of truth for
  // this session, so we honor it first and only fall back to URL params when the cookie is absent.
  const cookieJar = await cookies();
  const channelFromCookie = cookieJar.get('_rsoc_ch')?.value;
  const channel = channelFromCookie || gate.params.ch;
  // Conversion attribution: the click id (txid) — same priority chain as channel.
  const clickIdFromCookie = cookieJar.get('_rsoc_txid')?.value;
  const clickId = clickIdFromCookie || gate.params.txid;
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
            Web-result count below — Google's Search-ads policy (ads ≤ results). Gated by the cloak
            gate: in `enforce` a tokenless direct hit renders no ads unit (clean results page). */}
        {gate.monetize && (
          <SearchAds
            query={query}
            referrerAdCreative={referrerAdCreative}
            channel={channel}
            site={site}
            maxAds={articles.length}
          />
        )}
        <WebResults host={host} articles={articles} />
        <ConversionTracker clickId={clickId} value={value} currency={currency} term={query || undefined} />
      </main>
    </>
  );
}
