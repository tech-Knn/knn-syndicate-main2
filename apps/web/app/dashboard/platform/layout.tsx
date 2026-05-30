'use client';

import { type ReactNode, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui';
import { useAuth } from '../../providers';
import styles from './platform.module.css';

/**
 * Platform hub — a settings-style left sub-nav over all super-admin setup surfaces, with
 * ONE super-admin guard (replacing the per-page redirects). Every /dashboard/platform/*
 * route renders inside this. "Facebook" links to the shared /dashboard/facebook route
 * (buyers/company-admins use it too, so it isn't gated under /platform).
 */
const SUB_NAV: { href: string; label: string; external?: boolean }[] = [
  { href: '/dashboard/platform', label: 'Setup' }, // AdSense accounts · redirect domains · settings
  { href: '/dashboard/platform/companies', label: 'Companies' },
  { href: '/dashboard/platform/domains', label: 'Domains' },
  { href: '/dashboard/platform/channels', label: 'Channels' },
  { href: '/dashboard/platform/articles', label: 'Articles' },
  { href: '/dashboard/facebook', label: 'Facebook', external: true },
];

export default function PlatformLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (user && user.role !== 'SUPER_ADMIN') router.replace('/dashboard');
  }, [user, router]);

  if (!user) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }} role="status" aria-live="polite">
        <Spinner />
      </div>
    );
  }
  if (user.role !== 'SUPER_ADMIN') return null;

  return (
    <div className={styles.hub}>
      <nav className={styles.sidebar} aria-label="Platform">
        <div className={styles.eyebrow}>Platform</div>
        {SUB_NAV.map((item) => {
          const active = item.external
            ? pathname.startsWith(item.href)
            : item.href === '/dashboard/platform'
              ? pathname === '/dashboard/platform'
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`${styles.link} ${active ? styles.active : ''}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
