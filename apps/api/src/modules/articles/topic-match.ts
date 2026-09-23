// apps/api/src/modules/articles/topic-match.ts
//
// Cheap lexical checks that sit alongside the embedding similarity search.
// Embeddings alone can't tell that an article *labelled* "fatty liver" is actually
// *about* JCBs, so every reuse and every generation also has to pass a word-overlap
// check against the campaign's query.

/** Words that carry no topic meaning in our verticals. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'with', 'by', 'from',
  'your', 'you', 'my', 'me', 'our', 'is', 'are', 'how', 'what', 'why', 'which',
  'near', 'online', 'best', 'top', 'guide', 'buy', 'usa', 'india', 'read', 'more',
]);

/** Minimum share of the campaign query's content words an article must contain to be reused. */
export const REUSE_MIN_COVERAGE = 0.75;

/** Lowercase, strip punctuation, drop stopwords, naive plural stemming ("jobs" -> "job"). */
export function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
      .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );
}

/**
 * Fraction of `needle`'s content words that appear in `haystack` (0..1).
 * An empty needle returns 1, so a query made only of stopwords never blocks anything.
 */
export function coverage(needle: string, haystack: string): number {
  const n = contentTokens(needle);
  if (n.size === 0) return 1;
  const h = contentTokens(haystack);
  let hit = 0;
  for (const t of n) if (h.has(t)) hit++;
  return hit / n.size;
}

/** True when an existing article is actually about the campaign's query. */
export function articleMatchesQuery(
  anchor: string,
  article: { query: string | null; title: string },
): boolean {
  return coverage(anchor, `${article.query ?? ''} ${article.title}`) >= REUSE_MIN_COVERAGE;
}

/** True when the query and keywords share at least one content word. */
export function queryFitsKeywords(query: string, keywords: string[]): boolean {
  return coverage(query, keywords.join(' ')) > 0;
}