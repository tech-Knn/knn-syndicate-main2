import type { ReactNode } from 'react';
import { resolveSiteName } from '../_afs/site-config';
import { SiteFooter } from './site-footer';
import styles from './legal-page.module.css';

/**
 * Shared shell for the static legal/info pages (About, Contact, Privacy, Copyright,
 * Disclaimer). Unlike the article money-page, these DO carry a small brand masthead —
 * legitimacy matters more than bounce on a policy page, and a real-looking publisher
 * needs these. Per-host brand; shared editorial footer.
 */
export async function LegalPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): Promise<React.ReactElement> {
  const siteName = await resolveSiteName();
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/">
          {siteName}
        </a>
      </header>
      <main className={styles.main}>
        <h1 className={styles.title}>{title}</h1>
        <div className={styles.prose}>{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}
