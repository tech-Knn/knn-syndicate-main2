import styles from './search.module.css';

/**
 * Organic "Web results" for the RSOC results page — the host's own READY articles, so the
 * AFS ads SUPPLEMENT real search results (Google Search-ads policy: "ads supplement search
 * results, not act as the results themselves"; "number of ads ≤ number of search results").
 * Every competitor funnel (rvguide / storyimagur / creatorrule) shows this; we didn't.
 *
 * SPEED: this is an async Server Component the page wraps in <Suspense>, so it NEVER blocks
 * the ad request — the ads (inline `_googCsa` bootstrap) flush in the first chunk and fire
 * during parse; these results stream in a moment later. The fetch is cached (revalidate +
 * the API's own Cache-Control), so it's a cache hit on the hot path — no DB on the critical
 * path. Server-rendered HTML only: no client JS, no extra third-party widget.
 */

const API_BASE = process.env.ARTICLE_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

export interface ArticleSummary {
  slug: string;
  title: string;
  snippet: string;
}

/**
 * Fetch the host's organic Web results once, server-side. The result is shared by both the
 * <SearchAds> decision (ads ≤ organic count — Google policy) and the rendered <WebResults>
 * block, so the count is authoritative and there's no double fetch. Cached (revalidate + the
 * API's Cache-Control), so it's a cache hit on the hot path — no DB on the money-page critical
 * path. Errors / empty host → `[]`, which suppresses the ads entirely (no ads without results).
 */
export async function fetchWebResults(host: string): Promise<ArticleSummary[]> {
  if (!host) return [];
  try {
    const res = await fetch(`${API_BASE}/api/public/articles?host=${encodeURIComponent(host)}&limit=5`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    return ((await res.json()) as { articles?: ArticleSummary[] }).articles ?? [];
  } catch {
    return []; // never break the results page for the organic block
  }
}

export function WebResults({
  host,
  articles,
}: {
  host: string;
  articles: ArticleSummary[];
}): React.ReactElement | null {
  if (articles.length === 0) return null;

  return (
    <section className={styles.web} aria-label="Web results">
      <h2 className={styles.webHead}>Web results</h2>
      {articles.map((a) => {
        const path = `/a/${a.slug}`;
        return (
          <article key={a.slug} className={styles.webItem}>
            <a className={styles.webTitle} href={`https://${host}${path}`}>
              {a.title}
            </a>
            <div className={styles.webCite}>
              {host}
              {path}
            </div>
            {a.snippet ? <p className={styles.webSnippet}>{a.snippet}</p> : null}
          </article>
        );
      })}
    </section>
  );
}
