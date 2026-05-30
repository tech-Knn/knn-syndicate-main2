'use client';

import { type ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Badge, Button, Spinner } from '@/components/ui';
import { type Role } from '@/lib/types';
import { useAuth } from '../providers';
import styles from './dashboard.module.css';

const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Platform',
  COMPANY_ADMIN: 'Admin',
  MEDIA_BUYER: 'Buyer',
};

function navFor(role: Role): { href: string; label: string }[] {
  const isAdmin = role === 'SUPER_ADMIN' || role === 'COMPANY_ADMIN';
  return [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/analytics', label: 'Analytics' },
    { href: '/dashboard/campaigns', label: 'Campaigns' },
    ...(isAdmin ? [{ href: '/dashboard/approvals', label: 'Approvals' }] : []),
    ...(role === 'COMPANY_ADMIN' ? [{ href: '/dashboard/team', label: 'Team' }] : []),
    // Super-admin: Companies / Domains / Channels / Articles / AdSense / Facebook all live
    // inside the Platform hub (a left sub-nav). Facebook stays a top tab for the other roles.
    ...(role === 'SUPER_ADMIN' ? [{ href: '/dashboard/platform', label: 'Platform' }] : []),
    ...(role !== 'SUPER_ADMIN' ? [{ href: '/dashboard/facebook', label: 'Facebook' }] : []),
  ];
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, state, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (state === 'anon') router.replace('/login');
  }, [state, router]);

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

  return (
    <div className={styles.shell}>
      <a href="#main-content" className="skipLink">
        Skip to content
      </a>
      <header className={styles.topbar}>
        <Link href="/dashboard" className={styles.brand} aria-label="KNN Syndicate — home">
          <span className={styles.brandMark}>KNN</span>
          <span className={styles.brandName}>Syndicate</span>
        </Link>

        <nav className={styles.nav} aria-label="Primary">
          {items.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`${styles.navLink} ${active ? styles.navActive : ''}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className={styles.spacer} />

        <div className={styles.user}>
          <div className={styles.userMeta}>
            <div className={styles.userName}>{user.name}</div>
            <div className={styles.userEmail}>{user.email}</div>
          </div>
          <Badge tone={user.role === 'SUPER_ADMIN' ? 'brand' : 'neutral'}>{ROLE_LABEL[user.role]}</Badge>
          <Button variant="ghost" onClick={() => void onSignOut()} loading={signingOut} className={styles.signOut}>
            Sign out
          </Button>
        </div>

        <button
          type="button"
          className={styles.hamburger}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span aria-hidden>{menuOpen ? '✕' : '☰'}</span>
        </button>
      </header>

      {menuOpen && (
        <>
          <button
            type="button"
            className={styles.drawerScrim}
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setMenuOpen(false)}
          />
          <nav id="mobile-nav" className={styles.drawer} aria-label="Primary">
            {items.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`${styles.drawerLink} ${active ? styles.drawerActive : ''}`}
                >
                  {item.label}
                </Link>
              );
            })}
            <div className={styles.drawerUser}>
              <div className={styles.userName}>{user.name}</div>
              <div className={styles.userEmail}>{user.email}</div>
            </div>
            <Button variant="ghost" block onClick={() => void onSignOut()} loading={signingOut}>
              Sign out
            </Button>
          </nav>
        </>
      )}

      <main id="main-content" tabIndex={-1} className={styles.main}>
        {children}
      </main>
    </div>
  );
}
