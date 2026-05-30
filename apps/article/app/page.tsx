import { headers } from 'next/headers';
import { resolveSiteName } from './_afs/site-config';
import styles from './a/[slug]/article.module.css';

// Server-side base for the public article API (articles.<domain> ≠ app.<domain>).
const API_BASE = process.env.ARTICLE_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

interface ArticleSummary {
  slug: string;
  title: string;
  snippet: string;
}

/** Recently published articles for THIS host (same source as the /search organic results). */
async function fetchRecentArticles(host: string): Promise<ArticleSummary[]> {
  if (!host) return [];
  try {
    const res = await fetch(`${API_BASE}/api/public/articles?host=${encodeURIComponent(host)}&limit=10`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    return ((await res.json()) as { articles?: ArticleSummary[] }).articles ?? [];
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const host = (await headers()).get('host') ?? '';
  const [siteName, articles] = await Promise.all([resolveSiteName(), fetchRecentArticles(host)]);
  const year = new Date().getFullYear();

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
          <h1 className={styles.title}>{siteName}</h1>
          <p className={styles.lead}>
            In-depth guides and explainers on the topics readers ask about most — written to
            answer the question, then point you to what to read next.
          </p>

          <div className={styles.body}>
            <h2>Latest articles</h2>
            {articles.length === 0 ? (
              <p>No articles have been published yet. Please check back soon.</p>
            ) : (
              <ul>
                {articles.map((a) => (
                  <li key={a.slug}>
                    <a href={`/a/${a.slug}`}>{a.title}</a>
                    {a.snippet ? <span> — {a.snippet}</span> : null}
                  </li>
                ))}
              </ul>
            )}
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
