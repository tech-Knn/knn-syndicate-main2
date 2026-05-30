import { resolveSiteName } from '../../_afs/site-config';
import styles from './article.module.css';

export default async function ArticleNotFound() {
  const siteName = await resolveSiteName();
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
          <h1 className={styles.title}>Article not found</h1>
          <p className={styles.lead}>
            This article doesn’t exist or is no longer available.
          </p>
          <div className={styles.body}>
            <p>
              <a href="/">← Back to {siteName}</a>
            </p>
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
