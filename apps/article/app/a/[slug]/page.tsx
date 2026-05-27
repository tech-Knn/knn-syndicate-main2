import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { articleParagraphs, articleTeaser } from '@knn/shared';
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
  const paragraphs = articleParagraphs(article.compliantContent);
  // Required (since 2025-11-01) when traffic comes from a source you control (our
  // FB ads); the redirect passes the originating ad creative as `rc`.
  const referrerAdCreative = str(sp.rc) || undefined;
  // Publisher-provided related-search terms (the redirect passes campaign keywords/
  // RAC as `terms`; falls back to the article's own keywords). Only sent alongside
  // referrerAdCreative, which Google requires when `terms` is used.
  const terms = str(sp.terms) || article.keywords.join(',') || undefined;

  return (
    <main className={styles.page}>
      <article className={styles.article}>
        <h1 className={styles.title}>{article.title}</h1>
        {teaser && <p className={styles.lead}>{teaser}</p>}

        {/* RSOC related-search unit (content-targeted). Clicks → /search results page. */}
        <RelatedSearchUnit referrerAdCreative={referrerAdCreative} terms={terms} />

        <div className={styles.body}>
          {paragraphs.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      </article>
    </main>
  );
}
