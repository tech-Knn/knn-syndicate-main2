'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Spinner,
  useConfirm,
  usePrompt,
  useToast,
} from '@/components/ui';
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
  PAUSED: { label: 'Paused', tone: 'warning' },
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
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [list, setList] = useState<Campaign[] | 'error' | null>(null);
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(() => {
    setList(null);
    void campaignsApi
      .list()
      .then(setList)
      .catch(() => setList('error'));
  }, []);
  const loadPresets = useCallback(() => {
    void campaignsApi
      .presets()
      .then((p) => setPresets(p.map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => setPresets([]));
  }, []);

  useEffect(load, [load]);
  useEffect(loadPresets, [loadPresets]);

  async function remove(id: string, name: string) {
    const ok = await confirm({
      title: 'Delete campaign?',
      body: `“${name}” will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await campaignsApi.remove(id);
      toast.success('Campaign deleted.');
      load();
    } catch {
      toast.error('Could not delete the campaign.');
    }
  }

  // Withdraw a pending submission / revise a rejected one back to an editable draft.
  async function reopen(id: string) {
    try {
      await campaignsApi.reopen(id);
      router.push(`/dashboard/campaigns/${id}`);
    } catch {
      toast.error('Could not reopen the campaign.');
    }
  }

  // Duplicate a campaign into a fresh editable draft (new redirect ids, same config + offers).
  async function clone(id: string) {
    try {
      const created = await campaignsApi.clone(id);
      toast.success('Campaign cloned to a new draft.');
      router.push(`/dashboard/campaigns/${created.id}`);
    } catch {
      toast.error('Could not clone the campaign.');
    }
  }

  // Save a campaign's config (targeting/budget/ads/offers) as a reusable preset.
  async function savePreset(id: string) {
    const name = await prompt({
      title: 'Save as preset',
      body: 'Reuse this campaign’s targeting, budget, ads and offers to start new campaigns faster.',
      label: 'Preset name',
      placeholder: 'e.g. Health — US 25-54',
      confirmLabel: 'Save preset',
      validate: (v) => (v.trim() ? null : 'Enter a name for the preset.'),
    });
    if (name === null) return;
    try {
      await campaignsApi.savePreset(id, name);
      loadPresets();
      toast.success('Preset saved — start a new campaign from it via “New from preset”.');
    } catch {
      toast.error('Could not save the preset.');
    }
  }

  // Spin up a fresh editable draft from a preset.
  async function applyPreset(presetId: string) {
    if (!presetId) return;
    try {
      const created = await campaignsApi.applyPreset(presetId);
      router.push(`/dashboard/campaigns/${created.id}`);
    } catch {
      toast.error('Could not create a campaign from that preset.');
    }
  }

  // Bulk generator: clone a campaign into N fresh drafts in one go (1–20).
  async function bulkClone(id: string) {
    const raw = await prompt({
      title: 'Bulk clone',
      body: 'Create several editable draft copies at once — each gets fresh redirect IDs.',
      label: 'How many copies? (1–20)',
      defaultValue: '3',
      confirmLabel: 'Create copies',
      validate: (v) => {
        const n = Math.trunc(Number(v));
        return Number.isFinite(n) && n >= 1 && n <= 20 ? null : 'Enter a number between 1 and 20.';
      },
    });
    if (raw === null) return;
    const count = Math.min(Math.trunc(Number(raw)), 20);
    try {
      const res = await campaignsApi.bulkClone(id, count);
      load();
      toast.success(`Created ${res.count} draft cop${res.count === 1 ? 'y' : 'ies'}.`);
    } catch {
      toast.error('Could not bulk-clone the campaign.');
    }
  }

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={`serif ${styles.title}`}>Campaigns</h1>
          <p className={styles.subtitle}>Build an offer, attach creatives, and submit for approval.</p>
        </div>
        <div className={styles.headerActions}>
          {presets.length > 0 && (
            <select
              aria-label="Start a new campaign from a saved preset"
              className={styles.presetSelect}
              defaultValue=""
              onChange={(e) => {
                const id = e.target.value;
                e.currentTarget.value = '';
                void applyPreset(id);
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
      ) : list === 'error' ? (
        <Banner
          tone="error"
          title="Couldn’t load your campaigns"
          action={
            <Button variant="secondary" onClick={load}>
              Retry
            </Button>
          }
        >
          Something went wrong fetching the list.
        </Banner>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<span aria-hidden>🚀</span>}
            title="Launch your first campaign"
            description="Pick keywords, attach ad creatives, choose a destination website, and submit it for approval. Revenue is attributed back to every ad automatically."
            action={<Button onClick={() => router.push('/dashboard/campaigns/new')}>New campaign</Button>}
          />
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
                <Badge tone={STATUS[c.status].tone} dot={STATUS[c.status].tone !== 'neutral'}>
                  {STATUS[c.status].label}
                </Badge>
                <span className={styles.meta}>
                  {new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                <div className={styles.actions}>
                  <Link href={`/dashboard/campaigns/${c.id}`} className={`${styles.linkBtn} ${styles.linkBtnPrimary}`}>
                    {editable ? 'Edit' : 'View'}
                  </Link>
                  <button className={styles.linkBtn} onClick={() => void clone(c.id)} aria-label={`Clone ${c.name}`}>
                    Clone
                  </button>
                  <button className={styles.linkBtn} onClick={() => void savePreset(c.id)} aria-label={`Save ${c.name} as a preset`}>
                    Save preset
                  </button>
                  <button className={styles.linkBtn} onClick={() => void bulkClone(c.id)} aria-label={`Bulk clone ${c.name}`}>
                    Bulk clone
                  </button>
                  {reopenable && (
                    <button className={styles.linkBtn} onClick={() => void reopen(c.id)}>
                      {c.status === 'REJECTED' ? 'Revise' : 'Withdraw'}
                    </button>
                  )}
                  {removable && (
                    <button
                      className={`${styles.linkBtn} ${styles.del}`}
                      onClick={() => void remove(c.id, c.name)}
                      aria-label={`Delete ${c.name}`}
                    >
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
