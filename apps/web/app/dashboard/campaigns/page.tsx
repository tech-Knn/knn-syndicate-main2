'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Spinner } from '@/components/ui';
import { campaigns as campaignsApi } from '@/lib/api';
import { type Campaign, type CampaignStatus } from '@/lib/types';
import styles from './campaigns.module.css';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const STATUS: Record<CampaignStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PENDING_APPROVAL: { label: 'Pending approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'brand' },
  PROCESSING: { label: 'Processing', tone: 'brand' },
  LAUNCHING: { label: 'Launching', tone: 'brand' },
  ACTIVE: { label: 'Active', tone: 'success' },
  PAUSED: { label: 'Paused', tone: 'neutral' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  BATCHED: { label: 'Batched', tone: 'warning' },
  QUEUED_NO_CHANNEL: { label: 'Queued', tone: 'warning' },
  META_REJECTED: { label: 'Meta rejected', tone: 'danger' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
};

function countAds(c: Campaign): number {
  return c.adSets.reduce((n, s) => n + s.ads.length, 0);
}

export default function CampaignsPage() {
  const router = useRouter();
  const [list, setList] = useState<Campaign[] | null>(null);

  const load = useCallback(() => {
    void campaignsApi
      .list()
      .then(setList)
      .catch(() => setList([]));
  }, []);

  useEffect(load, [load]);

  async function remove(id: string) {
    if (!window.confirm('Delete this campaign? This cannot be undone.')) return;
    try {
      await campaignsApi.remove(id);
      load();
    } catch {
      window.alert('Could not delete the campaign.');
    }
  }

  // Withdraw a pending submission / revise a rejected one back to an editable draft.
  async function reopen(id: string) {
    try {
      await campaignsApi.reopen(id);
      router.push(`/dashboard/campaigns/${id}`);
    } catch {
      window.alert('Could not reopen the campaign.');
    }
  }

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={`serif ${styles.title}`}>Campaigns</h1>
          <p className={styles.subtitle}>Build an offer, attach creatives, and submit for approval.</p>
        </div>
        <Button onClick={() => router.push('/dashboard/campaigns/new')}>New campaign</Button>
      </div>

      {list === null ? (
        <Card className={styles.center}>
          <Spinner />
        </Card>
      ) : list.length === 0 ? (
        <Card className={styles.empty}>
          <h2 className={styles.emptyTitle}>No campaigns yet</h2>
          <p className={styles.emptyText}>
            Launch your first offer — pick keywords, attach ad creatives, and submit it for approval.
          </p>
          <Button onClick={() => router.push('/dashboard/campaigns/new')}>New campaign</Button>
        </Card>
      ) : (
        <Card className={styles.list}>
          {list.map((c) => {
            const editable = c.status === 'DRAFT';
            const removable = c.status === 'DRAFT' || c.status === 'REJECTED';
            const reopenable = c.status === 'PENDING_APPROVAL' || c.status === 'REJECTED';
            return (
              <div key={c.id} className={styles.row}>
                <div className={styles.name}>
                  <span className={styles.nameMain}>{c.name}</span>
                  <span className={styles.nameSub}>
                    {c.adSets.length} ad set{c.adSets.length === 1 ? '' : 's'} · {countAds(c)} ad
                    {countAds(c) === 1 ? '' : 's'}
                  </span>
                  {c.status === 'REJECTED' && c.rejectionReason && (
                    <span className={styles.reason}>Rejected: {c.rejectionReason}</span>
                  )}
                </div>
                <Badge tone={STATUS[c.status].tone} dot={c.status === 'ACTIVE'}>
                  {STATUS[c.status].label}
                </Badge>
                <span className={styles.meta}>
                  {new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                <div className={styles.actions}>
                  <Link href={`/dashboard/campaigns/${c.id}`} className={styles.linkBtn}>
                    {editable ? 'Edit' : 'View'}
                  </Link>
                  {reopenable && (
                    <button className={styles.linkBtn} onClick={() => void reopen(c.id)}>
                      {c.status === 'REJECTED' ? 'Revise' : 'Withdraw'}
                    </button>
                  )}
                  {removable && (
                    <button className={`${styles.linkBtn} ${styles.del}`} onClick={() => void remove(c.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
