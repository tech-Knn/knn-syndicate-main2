'use client';

import { type ReactNode, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui';
import { useAuth } from '../../providers';

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
      <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
        <Spinner />
      </div>
    );
  }
  if (user.role !== 'SUPER_ADMIN') return null;

  return (
    <div style={{ display: 'flex', gap: '1.75rem', alignItems: 'flex-start' }}>
      <aside
        style={{
          flex: '0 0 11rem',
          position: 'sticky',
          top: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.15rem',
        }}
      >
        <div style={{ fontSize: '0.7rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', padding: '0 0.7rem 0.4rem' }}>
          Platform
        </div>
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
              style={{
                padding: '0.5rem 0.7rem',
                borderRadius: 'var(--radius-sm, 8px)',
                fontSize: '0.9rem',
                textDecoration: 'none',
                color: active ? 'var(--cream)' : 'var(--muted)',
                background: active ? 'rgba(217,81,44,0.12)' : 'transparent',
                borderLeft: active ? '2px solid var(--rust, #d9512c)' : '2px solid transparent',
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </aside>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>{children}</div>
    </div>
  );
}
