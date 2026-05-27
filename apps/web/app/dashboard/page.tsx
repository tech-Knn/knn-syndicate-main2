'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Card } from '@/components/ui';
import { facebook } from '@/lib/api';
import { type ConnectionStatus } from '@/lib/types';
import { useAuth } from '../providers';
import styles from './home.module.css';

function fbBadge(status: ConnectionStatus | null) {
  if (!status) return <Badge tone="neutral">Loading…</Badge>;
  if (!status.connected) return <Badge tone="neutral">Not connected</Badge>;
  if (status.status === 'CONNECTION_BROKEN')
    return (
      <Badge tone="danger" dot>
        Reconnect needed
      </Badge>
    );
  return (
    <Badge tone="success" dot>
      Connected
    </Badge>
  );
}

export default function DashboardHome() {
  const { user } = useAuth();
  const [fb, setFb] = useState<ConnectionStatus | null>(null);

  useEffect(() => {
    let active = true;
    void facebook
      .status()
      .then((s) => active && setFb(s))
      .catch(() => active && setFb({ connected: false }));
    return () => {
      active = false;
    };
  }, []);

  const firstName = user?.name.split(' ')[0] ?? 'there';

  return (
    <div>
      <h1 className={`serif ${styles.greeting}`}>Hello, {firstName}.</h1>
      <p className={styles.sub}>Your arbitrage console. Connect a data source to get started.</p>

      <div className={styles.grid}>
        <Link href="/dashboard/facebook" style={{ color: 'inherit' }}>
          <Card className={`${styles.tile} ${styles.tileLink}`}>
            <span className={styles.tileLabel}>Facebook</span>
            <span className={styles.tileValue}>Ad source</span>
            <div className={styles.tileFoot}>{fbBadge(fb)}</div>
          </Card>
        </Link>

        <Card className={`${styles.tile} ${styles.soon}`}>
          <span className={styles.tileLabel}>Campaigns</span>
          <span className={styles.tileValue}>Launcher</span>
          <div className={styles.tileFoot}>Coming in the ad-launcher phase</div>
        </Card>

        <Card className={`${styles.tile} ${styles.soon}`}>
          <span className={styles.tileLabel}>Revenue</span>
          <span className={styles.tileValue}>Attribution</span>
          <div className={styles.tileFoot}>Coming in the stats phase</div>
        </Card>
      </div>
    </div>
  );
}
