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
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(() => {
    void campaignsApi
      .list()
      .then(setList)
      .catch(() => setList([]));
  }, []);
  const loadPresets = useCallback(() => {
    void campaignsApi
      .presets()
      .then((p) => setPresets(p.map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => setPresets([]));
  }, []);

  useEffect(load, [load]);
  useEffect(loadPresets, [loadPresets]);

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

  // Duplicate a campaign into a fresh editable draft (new redirect ids, same config + offers).
  async function clone(id: string) {
    try {
      const created = await campaignsApi.clone(id);
      router.push(`/dashboard/campaigns/${created.id}`);
    } catch {
      window.alert('Could not clone the campaign.');
    }
  }

  // Save a campaign's config (targeting/budget/ads/offers) as a reusable preset.
  async function savePreset(id: string) {
    const name = window.prompt('Save this campaign as a reusable preset. Preset name:');
    if (!name?.trim()) return;
    try {
      await campaignsApi.savePreset(id, name.trim());
      loadPresets();
      window.alert('Preset saved — start a new campaign from it via "New from preset".');
    } catch {
      window.alert('Could not save the preset.');
    }
  }

  // Spin up a fresh editable draft from a preset.
  async function applyPreset(presetId: string) {
    if (!presetId) return;
    try {
      const created = await campaignsApi.applyPreset(presetId);
      router.push(`/dashboard/campaigns/${created.id}`);
    } catch {
      window.alert('Could not create a campaign from that preset.');
    }
  }

  // Bulk generator: clone a campaign into N fresh drafts in one go (1–20).
  async function bulkClone(id: string) {
    const raw = window.prompt('Bulk clone — how many draft copies? (1–20)', '3');
    if (raw === null) return;
    const count = Math.trunc(Number(raw));
    if (!Number.isFinite(count) || count < 1) {
      window.alert('Enter a number between 1 and 20.');
      return;
    }
    try {
      const res = await campaignsApi.bulkClone(id, Math.min(count, 20));
      load();
      window.alert(`Created ${res.count} draft cop${res.count === 1 ? 'y' : 'ies'}.`);
    } catch {
      window.alert('Could not bulk-clone the campaign.');
    }
  }

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={`serif ${styles.title}`}>Campaigns</h1>
          <p className={styles.subtitle}>Build an offer, attach creatives, and submit for approval.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          {presets.length > 0 && (
            <select
              aria-label="Start a new campaign from a saved preset"
              defaultValue=""
              onChange={(e) => {
                const id = e.target.value;
                e.currentTarget.value = '';
                void applyPreset(id);
              }}
              style={{
                padding: '0.55rem 0.7rem',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-strong)',
                background: 'var(--surface)',
                color: 'var(--cream)',
                fontSize: '0.85rem',
              }}
            >
              <option value="" disabled>
                New from preset…
              </option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <Button onClick={() => router.push('/dashboard/campaigns/new')}>New campaign</Button>
        </div>
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
                  <button className={styles.linkBtn} onClick={() => void clone(c.id)}>
                    Clone
                  </button>
                  <button className={styles.linkBtn} onClick={() => void savePreset(c.id)}>
                    Save preset
                  </button>
                  <button className={styles.linkBtn} onClick={() => void bulkClone(c.id)}>
                    Bulk clone
                  </button>
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
