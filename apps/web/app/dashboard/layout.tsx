'use client';

import { type ReactNode, useEffect } from 'react';
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
    { href: '/dashboard/campaigns', label: 'Campaigns' },
    ...(isAdmin ? [{ href: '/dashboard/approvals', label: 'Approvals' }] : []),
    ...(role === 'COMPANY_ADMIN' ? [{ href: '/dashboard/team', label: 'Team' }] : []),
    ...(role === 'SUPER_ADMIN' ? [{ href: '/dashboard/companies', label: 'Companies' }] : []),
    ...(role === 'SUPER_ADMIN' ? [{ href: '/dashboard/platform', label: 'Platform' }] : []),
    ...(role === 'SUPER_ADMIN' ? [{ href: '/dashboard/domains', label: 'Domains' }] : []),
    { href: '/dashboard/facebook', label: 'Facebook' },
  ];
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, state, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (state === 'anon') router.replace('/login');
  }, [state, router]);

  if (state !== 'authed' || !user) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link href="/dashboard" className={styles.brand}>
          <span className={styles.brandMark}>KNN</span>
          <span className={styles.brandName}>Syndicate</span>
        </Link>

        <nav className={styles.nav}>
          {navFor(user.role).map((item) => {
            const active =
              item.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
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
          <Badge tone={user.role === 'SUPER_ADMIN' ? 'brand' : 'neutral'}>
            {ROLE_LABEL[user.role]}
          </Badge>
          <Button variant="ghost" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  );
}
