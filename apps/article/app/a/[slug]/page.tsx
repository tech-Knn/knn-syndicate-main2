import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { articleBlocks, articleTeaser } from '@knn/shared';
import { RelatedSearchUnit } from './related-search-unit';
import styles from './article.module.css';

// Server-side base for the public article API. articles.<domain> is a different
// origin than the API (app.<domain>), so this is an absolute URL.
const API_BASE = process.env.ARTICLE_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

interface PublicArticle {
  slug: string;
  title: string;
  compliantContent: string;
  query: string | null;
  keywords: string[];
  relatedSearchTerms: string[];
}

async function fetchArticle(slug: string): Promise<PublicArticle | null> {
  try {
    const res = await fetch(`${API_BASE}/api/public/articles/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { article: PublicArticle };
    return data.article;
  } catch {
    return null;
  }
}

function str(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = await fetchArticle(slug);
  if (!article) return { title: 'Article not found' };
  const description = articleTeaser(article.compliantContent, 30, 160);
  return {
    title: article.title,
    description,
    openGraph: { title: article.title, description, type: 'article' },
  };
}

export default async function ArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const article = await fetchArticle(slug);
  if (!article) notFound();

  const teaser = articleTeaser(article.compliantContent);
  const blocks = articleBlocks(article.compliantContent);
  // The opening paragraph is shown as the lead (above the AFS unit), so drop it from
  // the body to avoid repeating it.
  const bodyBlocks = blocks[0]?.type === 'p' ? blocks.slice(1) : blocks;
  // Required (since 2025-11-01) when traffic comes from a source you control (our
  // FB ads); the redirect passes the originating ad creative as `rc`.
  const referrerAdCreative = str(sp.rc) || undefined;
  // Publisher-provided related-search terms. Preference: explicit `terms` from the
  // redirect → the article's AI-generated high-CPC related searches → campaign
  // keywords. Only sent alongside referrerAdCreative, which Google requires.
  const terms =
    str(sp.terms) || article.relatedSearchTerms.join(',') || article.keywords.join(',') || undefined;

  return (
    <main className={styles.page}>
      <article className={styles.article}>
        <h1 className={styles.title}>{article.title}</h1>
        {teaser && <p className={styles.lead}>{teaser}</p>}

        {/* RSOC related-search unit (content-targeted). Clicks → /search results page. */}
        <RelatedSearchUnit referrerAdCreative={referrerAdCreative} terms={terms} />

        <div className={styles.body}>
          {bodyBlocks.map((block, i) => {
            if (block.type === 'h2') return <h2 key={i}>{block.text}</h2>;
            if (block.type === 'h3') return <h3 key={i}>{block.text}</h3>;
            if (block.type === 'ul')
              return (
                <ul key={i}>
                  {block.items.map((it, j) => (
                    <li key={j}>{it}</li>
                  ))}
                </ul>
              );
            if (block.type === 'ol')
              return (
                <ol key={i}>
                  {block.items.map((it, j) => (
                    <li key={j}>{it}</li>
                  ))}
                </ol>
              );
            return <p key={i}>{block.text}</p>;
          })}
        </div>
      </article>
    </main>
  );
}
