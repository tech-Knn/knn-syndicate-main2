'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { useAuth } from './providers';
import styles from './landing.module.css';

const POINTS = [
  {
    title: 'Launch in minutes',
    body: 'Build Facebook ad campaigns — objectives, audiences, creatives — from one guided launcher.',
  },
  {
    title: 'Monetized landings',
    body: 'Traffic is cloaked to AI-built article pages with a Google AdSense search unit, tuned per offer.',
  },
  {
    title: 'Revenue, attributed',
    body: 'AFS earnings flow back to the originating ad and campaign, so every dollar of ROI is visible in real time.',
  },
];

export default function HomePage() {
  const { state } = useAuth();
  const router = useRouter();

  // Already signed in? Go straight to the workspace.
  useEffect(() => {
    if (state === 'authed') router.replace('/dashboard');
  }, [state, router]);

  return (
    <main className={styles.page}>
      <div className={styles.hero}>
        <span className="eyebrow">KNN Syndicate</span>
        <h1 className={styles.title}>The search-arbitrage platform for performance teams</h1>
        <p className={styles.lede}>
          Launch Facebook ad campaigns, route traffic to monetized article pages, and see AdSense
          revenue attributed back to every ad — in one workspace, in real time.
        </p>
        <div className={styles.ctaRow}>
          <Link href="/login">
            <Button>Sign in</Button>
          </Link>
          <Link href="/signup">
            <Button variant="secondary">Create an account</Button>
          </Link>
        </div>
      </div>

      <div className={styles.points}>
        {POINTS.map((p) => (
          <div key={p.title} className={styles.point}>
            <div className={styles.pointTitle}>{p.title}</div>
            <p className={styles.pointBody}>{p.body}</p>
          </div>
        ))}
      </div>

      <p className={styles.trust}>Multi-tenant · role-based access · self-hosted</p>
    </main>
  );
}
