import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { articleParagraphs, articleTeaser } from '@knn/shared';
import { AfsWidget } from './afs-widget';
import styles from './article.module.css';

// Server-side base for the public article API. articles.<domain> is a different
// origin than the API (app.<domain>), so this is an absolute URL.
const API_BASE = process.env.ARTICLE_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

interface PublicArticle {
  slug: string;
  title: string;
  compliantContent: string;
  query: string | null;
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
  // The redirect passes the search query/channel/style; fall back to the article's
  // own query when arriving without them.
  const query = str(sp.q) || article.query || '';
  const channel = str(sp.ch);
  // AFS account is configured via env; the URL styleId (per-campaign) overrides
  // the account default. pubId only ever comes from env (account-level).
  const pubId = process.env.NEXT_PUBLIC_AFS_PUB_ID ?? '';
  const styleId = str(sp.styleId) || (process.env.NEXT_PUBLIC_AFS_STYLE_ID ?? '');

  return (
    <main className={styles.page}>
      <article className={styles.article}>
        <h1 className={styles.title}>{article.title}</h1>
        {teaser && <p className={styles.lead}>{teaser}</p>}

        <AfsWidget pubId={pubId} query={query} channel={channel} styleId={styleId} />

        <div className={styles.body}>
          {paragraphs.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      </article>
    </main>
  );
}
