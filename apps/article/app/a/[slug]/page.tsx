import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { articleBlocks, articleTeaser } from '@knn/shared';
import { resolveSiteConfig, resolveSiteName } from '../../_afs/site-config';
import { RelatedSearchUnit } from './related-search-unit';
import styles from './article.module.css';

/** Long-form date for the article byline (e.g. "May 30, 2026"). */
const PUBLISH_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

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
  // Canonical points at this article's own URL on the request host (one article ↔ one
  // canonical), which keeps the editorial page from looking like duplicate/thin content
  // to crawlers. Derived from the request Host (same origin serving the page); omitted if
  // the host is unavailable so we never emit a wrong canonical.
  let canonicalUrl: string | undefined;
  try {
    const host = (await headers()).get('host');
    if (host) canonicalUrl = `https://${host}/a/${encodeURIComponent(slug)}`;
  } catch {
    /* host unavailable → omit canonical */
  }
  return {
    title: article.title,
    description,
    ...(canonicalUrl ? { alternates: { canonical: canonicalUrl } } : {}),
    openGraph: {
      title: article.title,
      description,
      type: 'article',
      ...(canonicalUrl ? { url: canonicalUrl } : {}),
    },
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
  const [article, site, siteName] = await Promise.all([
    fetchArticle(slug),
    resolveSiteConfig(),
    resolveSiteName(),
  ]);
  if (!article) notFound();

  const updated = PUBLISH_DATE_FMT.format(new Date());
  const year = new Date().getFullYear();

  const blocks = articleBlocks(article.compliantContent);
  // Deterministic lead/body de-dup: the FULL first paragraph is the lead (above the AFS
  // unit), rendered verbatim from the body's first block — so the exact same block is
  // dropped from the body. The opening paragraph thus appears once, never duplicated nor
  // truncated. (The short `articleTeaser` is the meta-description summary only.)
  const leadBlock = blocks[0]?.type === 'p' ? blocks[0] : null;
  const lead = leadBlock?.text ?? '';
  const bodyBlocks = leadBlock ? blocks.slice(1) : blocks;
  // Required (since 2025-11-01) when traffic comes from a source you control (our
  // FB ads); the redirect passes the originating ad creative as `rc`.
  const referrerAdCreative = str(sp.rc) || undefined;
  const txid = str(sp.txid) || undefined;
  // The offer's AFS channel (per-offer attribution); forwarded to /search by the unit.
  const channel = str(sp.ch) || undefined;
  // Publisher-provided related-search terms. Preference: explicit `terms` from the
  // redirect → the article's AI-generated high-CPC related searches → campaign
  // keywords. Only sent alongside referrerAdCreative, which Google requires.
  const terms =
    str(sp.terms) || article.relatedSearchTerms.join(',') || article.keywords.join(',') || undefined;

  return (
    <div className={styles.page}>
      <a className="skipLink" href="#main-content">
        Skip to content
      </a>
      <header className={styles.siteHeader}>
        <div className={styles.siteHeaderInner}>
          <a className={styles.brandLink} href="/">
            {siteName}
          </a>
          <span className={styles.siteTagline}>News &amp; Guides</span>
        </div>
      </header>

      <main id="main-content" className={styles.main}>
        <article className={styles.article}>
          <h1 className={styles.title}>{article.title}</h1>
          <div className={styles.meta}>
            <span className={styles.byline}>{siteName} Editorial Team</span>
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
            <span>
              Updated <time dateTime={new Date().toISOString().slice(0, 10)}>{updated}</time>
            </span>
          </div>
          {lead && <p className={styles.lead}>{lead}</p>}

          {/* RSOC related-search unit (content-targeted). Clicks → /search results page. */}
          <RelatedSearchUnit referrerAdCreative={referrerAdCreative} terms={terms} txid={txid} channel={channel} site={site} />

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

      <footer className={styles.siteFooter}>
        <div className={styles.siteFooterInner}>
          <nav className={styles.footerNav} aria-label="Footer">
            <a className={styles.footerLink} href="/about">
              About
            </a>
            <a className={styles.footerLink} href="/privacy">
              Privacy
            </a>
            <a className={styles.footerLink} href="/contact">
              Contact
            </a>
          </nav>
          <span className={styles.copyright}>
            © {year} {siteName}
          </span>
        </div>
      </footer>
    </div>
  );
}
