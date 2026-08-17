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

// Server-side base for the public article API (same env pattern used by /a/[slug]/page.tsx).
// Articles.<domain> is a different origin than the API (app.<domain>), so this is absolute.
const API_BASE = process.env.ARTICLE_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

/** Extract the article slug from a same-origin Referer like `.../a/<slug>` (or `.../a/<slug>?…`).
 *  Returns null on cross-origin or non-article referers. Belt-and-braces: bounded length, single-segment
 *  slug, no path traversal — we hand this straight to the API so it must not be attacker-controlled. */
function extractSlugFromReferer(referer: string | null, currentHost: string): string | null {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (url.host !== currentHost) return null;
    const match = url.pathname.match(/^\/a\/([A-Za-z0-9_-]{1,120})\/?$/);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** Bulletproof channel/RAC recovery: when cookie AND URL both miss, look up the article
 *  the visitor came from (via Referer) and use its active campaign's channel + RAC. This
 *  guarantees Google AFS never gets channel=1 for any of OUR campaigns, even when the
 *  browser (incognito / ITP / cross-context nav) has stripped every other carrier. */
async function fetchArticleAttribution(
  slug: string,
): Promise<{ channel: string | null; referrerAdCreative: string | null } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/public/articles/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      article?: { channel?: string | null; referrerAdCreative?: string | null };
    };
    return {
      channel: data.article?.channel ?? null,
      referrerAdCreative: data.article?.referrerAdCreative ?? null,
    };
  } catch {
    return null;
  }
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
  const hdrs = await headers();
  const host = hdrs.get('host') ?? '';
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
  // The offer's AFS channel (per-offer attribution) + referrerAdCreative + txid. Sources, priority order:
  //   1. Same-origin cookie `_rsoc_*` set by the article page (AUTHORITATIVE — our value)
  //   2. Token / URL params via cloak-gate (legacy / direct-visit fallback)
  //   3. Referer-based lookup: parse `/a/<slug>` from the referer, fetch the article's active
  //      campaign channel + RAC. Guarantees Google AFS NEVER receives channel=1 for our own
  //      campaigns even when both the cookie AND the URL token were stripped (incognito, ITP,
  //      Google's chip iframe stripping rc/ch/txid, etc.).
  //
  // Cookie MUST be first: Google's ads.js on /search often appends its own `?ch=1` telemetry param
  // after ads render, which cloak-gate would otherwise treat as "channel=1" and clobber our real
  // channel. Chip click navigation from Google's iframe strips the campaign's rc/ch/txid from the URL
  // (only `?q=<term>&rsToken=<googleToken>` is preserved), so cookies are the ONLY way to preserve
  // the campaign's referrerAdCreative and channel/txid on the /search render.
  const cookieJar = await cookies();
  const channelFromCookie = cookieJar.get('_rsoc_ch')?.value;
  const clickIdFromCookie = cookieJar.get('_rsoc_txid')?.value;
  const racFromCookie = cookieJar.get('_rsoc_rc')?.value;
  let channel = channelFromCookie || gate.params.ch;
  const clickId = clickIdFromCookie || gate.params.txid;
  let referrerAdCreative = racFromCookie || gate.params.rc;
  // Ultimate fallback (priority 3): only fire when the primary carriers actually failed AND we have
  // a same-origin referer pointing at one of our articles. Rare path — adds ~1 API round-trip only
  // when everything else missed, so the hot path is unaffected.
  if (!channel || !referrerAdCreative) {
    const refererSlug = extractSlugFromReferer(hdrs.get('referer'), host);
    if (refererSlug) {
      const attribution = await fetchArticleAttribution(refererSlug);
      if (attribution) {
        if (!channel && attribution.channel) channel = attribution.channel;
        if (!referrerAdCreative && attribution.referrerAdCreative) {
          referrerAdCreative = attribution.referrerAdCreative;
        }
      }
    }
  }
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
