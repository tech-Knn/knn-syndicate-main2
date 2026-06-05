'use client';

import { type ComponentType, type ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CommandPalette, type Command } from '@/components/command-palette';
import {
  IconAnalytics,
  IconApprovals,
  IconCampaigns,
  IconClose,
  IconFacebook,
  IconMenu,
  IconOverview,
  IconPlatform,
  IconSearch,
  IconSignOut,
  IconTeam,
} from '@/components/icons';
import { ThemeToggle, useTheme } from '@/components/theme';
import { Spinner } from '@/components/ui';
import { type Role } from '@/lib/types';
import { useAuth } from '../providers';
import styles from './dashboard.module.css';

const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Platform',
  COMPANY_ADMIN: 'Admin',
  MEDIA_BUYER: 'Buyer',
};

// Per-route document title + topbar heading (client pages can't export `metadata`); longest-prefix.
const TITLES: { prefix: string; label: string }[] = [
  { prefix: '/dashboard/campaigns/new', label: 'New campaign' },
  { prefix: '/dashboard/campaigns', label: 'Campaigns' },
  { prefix: '/dashboard/analytics', label: 'Analytics' },
  { prefix: '/dashboard/approvals', label: 'Approvals' },
  { prefix: '/dashboard/team', label: 'Team' },
  { prefix: '/dashboard/facebook', label: 'Facebook' },
  { prefix: '/dashboard/platform/companies', label: 'Companies' },
  { prefix: '/dashboard/platform/domains', label: 'Domains' },
  { prefix: '/dashboard/platform/channels', label: 'Channels' },
  { prefix: '/dashboard/platform/articles', label: 'Articles' },
  { prefix: '/dashboard/platform/cloaker', label: 'Cloaker' },
  { prefix: '/dashboard/platform', label: 'Platform' },
  { prefix: '/dashboard', label: 'Overview' },
];
function titleFor(pathname: string): string {
  return TITLES.find((t) => pathname === t.prefix || pathname.startsWith(`${t.prefix}/`))?.label ?? 'Dashboard';
}

type NavItem = { href: string; label: string; Icon: ComponentType<{ size?: number }> };
function navFor(role: Role): NavItem[] {
  const isAdmin = role === 'SUPER_ADMIN' || role === 'COMPANY_ADMIN';
  return [
    { href: '/dashboard', label: 'Overview', Icon: IconOverview },
    { href: '/dashboard/analytics', label: 'Analytics', Icon: IconAnalytics },
    { href: '/dashboard/campaigns', label: 'Campaigns', Icon: IconCampaigns },
    ...(isAdmin ? [{ href: '/dashboard/approvals', label: 'Approvals', Icon: IconApprovals }] : []),
    ...(role === 'COMPANY_ADMIN' ? [{ href: '/dashboard/team', label: 'Team', Icon: IconTeam }] : []),
    ...(role === 'SUPER_ADMIN' ? [{ href: '/dashboard/platform', label: 'Platform', Icon: IconPlatform }] : []),
    ...(role !== 'SUPER_ADMIN' ? [{ href: '/dashboard/facebook', label: 'Facebook', Icon: IconFacebook }] : []),
  ];
}

function initialsOf(name: string, email: string): string {
  const fromName = name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');
  return (fromName || email[0] || '?').toUpperCase();
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, state, logout } = useAuth();
  const { toggle: toggleTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);

  useEffect(() => {
    if (state === 'anon') router.replace('/login');
  }, [state, router]);

  // ⌘K / Ctrl-K toggles the command palette anywhere in the dashboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.title = `${titleFor(pathname)} · KNN Syndicate`;
  }, [pathname]);

  // Close the mobile drawer on navigation + on Escape.
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  if (state !== 'authed' || !user) {
    return (
      <div className={styles.center} role="status" aria-live="polite">
        <Spinner />
        <span className={styles.centerLabel}>Loading your workspace…</span>
      </div>
    );
  }

  const items = navFor(user.role);
  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href);

  const onSignOut = async () => {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  };

  const commands: Command[] = [
    ...items.map((it) => ({ id: `nav-${it.href}`, label: it.label, hint: 'Page', href: it.href, Icon: it.Icon, keywords: 'go to navigate open' })),
    ...(user.role !== 'SUPER_ADMIN'
      ? [{ id: 'new-campaign', label: 'New campaign', hint: 'Action', href: '/dashboard/campaigns/new', Icon: IconCampaigns, keywords: 'create launch build' }]
      : []),
    { id: 'toggle-theme', label: 'Toggle light / dark theme', hint: 'Action', action: toggleTheme, keywords: 'dark light mode appearance color' },
    { id: 'sign-out', label: 'Sign out', hint: 'Action', action: () => void onSignOut(), Icon: IconSignOut, keywords: 'logout log out exit' },
  ];

  return (
    <div className={styles.shell}>
      <a href="#main-content" className="skipLink">
        Skip to content
      </a>

      {menuOpen && (
        <button type="button" className={styles.scrim} aria-label="Close menu" tabIndex={-1} onClick={() => setMenuOpen(false)} />
      )}

      <aside className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.brand}>
          <Link href="/dashboard" className={styles.brandLink} aria-label="KNN Syndicate — home">
            <span className={styles.brandLogo} aria-hidden>
              K
            </span>
            <span className={styles.brandText}>
              <span className={styles.brandMark}>KNN</span>
              <span className={styles.brandName}>Syndicate</span>
            </span>
          </Link>
          <button type="button" className={styles.drawerClose} aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <IconClose size={20} />
          </button>
        </div>

        <nav className={styles.nav} aria-label="Primary">
          {items.map(({ href, label, Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`${styles.navLink} ${active ? styles.navActive : ''}`}
              >
                <Icon size={18} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className={styles.sidebarFoot}>
          <div className={styles.userCard}>
            <span className={styles.avatar} aria-hidden>
              {initialsOf(user.name, user.email)}
            </span>
            <span className={styles.userMeta}>
              <span className={styles.userName}>{user.name}</span>
              <span className={styles.userEmail}>{user.email}</span>
            </span>
          </div>
          <div className={styles.footActions}>
            <ThemeToggle className={styles.themeToggle} />
            <button type="button" className={styles.signOut} onClick={() => void onSignOut()} disabled={signingOut}>
              {signingOut ? <Spinner /> : <IconSignOut size={16} />}
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </aside>

      <div className={styles.content}>
        <header className={styles.topbar}>
          <button type="button" className={styles.hamburger} aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <IconMenu size={22} />
          </button>
          <h1 className={styles.pageTitle}>{titleFor(pathname)}</h1>
          <div className={styles.topbarRight}>
            <button type="button" className={styles.searchTrigger} onClick={() => setCmdOpen(true)} aria-label="Search — Command or Control K">
              <IconSearch size={15} />
              <span className={styles.searchText}>Search…</span>
              <kbd className={styles.searchKbd}>⌘K</kbd>
            </button>
            <span className={styles.roleBadge}>{ROLE_LABEL[user.role]}</span>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className={styles.main}>
          {children}
        </main>
      </div>

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} commands={commands} />
    </div>
  );
}
