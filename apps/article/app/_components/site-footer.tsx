import { resolveSiteName } from '../_afs/site-config';
import styles from './site-footer.module.css';

/** Footer links — the standard publisher set (mirrors the live RSOC funnels: Copyright /
 *  Disclaimer / Privacy), plus About + Contact for AdSense legitimacy. Each is a real page. */
const FOOTER_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/copyright', label: 'Copyright' },
  { href: '/disclaimer', label: 'Disclaimer' },
];

/**
 * Shared editorial footer (per-host brand). The ONLY chrome on the article money-page —
 * the top masthead is intentionally gone (focus on the RSOC unit, no bounce), but the
 * legal footer stays for legitimacy + AdSense/RSOC policy. Async server component: it
 * resolves the brand from the request host itself, so callers just render `<SiteFooter />`.
 */
export async function SiteFooter(): Promise<React.ReactElement> {
  const siteName = await resolveSiteName();
  const year = new Date().getFullYear();
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <span className={styles.copyright}>
          © {year} {siteName}
        </span>
        <nav className={styles.nav} aria-label="Footer">
          {FOOTER_LINKS.map((l) => (
            <a key={l.href} className={styles.link} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
