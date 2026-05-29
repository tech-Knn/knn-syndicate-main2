'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { CampaignWizard } from '@/components/campaign-wizard';
import { ApiError, campaigns } from '@/lib/api';
import { Button, Spinner } from '@/components/ui';
import { type Campaign } from '@/lib/types';
import { useAuth } from '../../../providers';
import { OffersEditor } from './offers-editor';

// Statuses where an admin can push the campaign live to Facebook (it has a channel).
const LAUNCHABLE = new Set(['PROCESSING', 'BATCHED']);

export default function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useAuth();
  const [campaign, setCampaign] = useState<Campaign | null | 'error'>(null);
  const [launching, setLaunching] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const isAdmin = user?.role === 'SUPER_ADMIN' || user?.role === 'COMPANY_ADMIN';

  const load = useCallback(() => {
    void campaigns
      .get(id)
      .then((c) => setCampaign(c))
      .catch(() => setCampaign('error'));
  }, [id]);
  useEffect(() => load(), [load]);

  if (campaign === 'error') {
    return <p style={{ color: 'var(--muted)' }}>Campaign not found.</p>;
  }
  if (campaign === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
        <Spinner />
      </div>
    );
  }

  const c = campaign;
  const launch = async (): Promise<void> => {
    setLaunching(true);
    setNote(null);
    try {
      const res = await campaigns.launch(c.id);
      setNote({ tone: 'ok', text: res.fbCampaignId ? `Sent to Facebook — status: ${res.status}.` : `Launch queued — status: ${res.status}.` });
      load();
    } catch (err) {
      setNote({ tone: 'err', text: err instanceof ApiError ? err.message : 'Launch failed.' });
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {isAdmin && LAUNCHABLE.has(c.status) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            padding: '0.85rem 1.1rem',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontSize: '0.9rem', color: 'var(--cream)' }}>
            <strong>{c.status === 'BATCHED' ? 'Rate-limited' : 'Ready to publish'}</strong> — a channel is assigned. Launching generates the article, wires the
            redirect, and creates the ads on Facebook.
          </div>
          <Button onClick={() => void launch()} loading={launching}>
            {launching ? 'Launching…' : 'Launch to Facebook'}
          </Button>
        </div>
      )}
      {note && (
        <div
          style={{
            padding: '0.75rem 1.1rem',
            borderRadius: 'var(--radius-sm)',
            background: note.tone === 'ok' ? 'rgba(58,160,90,0.12)' : 'rgba(200,60,60,0.12)',
            color: note.tone === 'ok' ? 'var(--green)' : 'var(--red)',
            fontSize: '0.88rem',
          }}
        >
          {note.text}
        </div>
      )}
      <CampaignWizard campaign={c} />
      <OffersEditor campaignId={c.id} status={c.status} />
    </div>
  );
}
