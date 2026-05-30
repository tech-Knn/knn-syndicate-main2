'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { CampaignWizard } from '@/components/campaign-wizard';
import { ApiError, campaigns } from '@/lib/api';
import { Button, Spinner } from '@/components/ui';
import { type Campaign } from '@/lib/types';
import { OffersEditor } from './offers-editor';

// Statuses where the campaign can be pushed live to Facebook (it has a channel). Manual
// launch is available to the owning buyer + admins (the API owner-scopes it).
const LAUNCHABLE = new Set(['PROCESSING', 'BATCHED']);
// Pre-launch states that can be reopened to DRAFT to fix config (releases the channel).
// Excludes LAUNCHING/ACTIVE/PAUSED (already on Facebook — pause first) and the review
// states (DRAFT/PENDING/REJECTED already have their own withdraw/revise paths).
const REOPENABLE = new Set(['PROCESSING', 'BATCHED', 'QUEUED_NO_CHANNEL']);
// Live on Facebook → the owning buyer (or an admin) can pause/resume delivery. The API
// owner-scopes it and flips the FB campaign status + ours (ACTIVE ↔ PAUSED).
const LIVE_TOGGLEABLE = new Set(['ACTIVE', 'PAUSED']);

export default function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [campaign, setCampaign] = useState<Campaign | null | 'error'>(null);
  const [launching, setLaunching] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

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

  const reopen = async (): Promise<void> => {
    if (typeof window !== 'undefined' && !window.confirm('Reopen this campaign for editing? It returns to draft and releases its assigned channel back to the pool. You can resubmit when you\'re done.')) {
      return;
    }
    setReopening(true);
    setNote(null);
    try {
      const updated = await campaigns.reopen(c.id);
      setCampaign(updated);
      setNote({ tone: 'ok', text: 'Campaign reopened — it\'s now an editable draft. Make your changes and submit again.' });
    } catch (err) {
      setNote({ tone: 'err', text: err instanceof ApiError ? err.message : 'Reopen failed.' });
    } finally {
      setReopening(false);
    }
  };

  const toggleActive = async (active: boolean): Promise<void> => {
    setToggling(true);
    setNote(null);
    try {
      const res = active ? await campaigns.resume(c.id) : await campaigns.pause(c.id);
      setCampaign({ ...c, status: res.status as Campaign['status'] });
      setNote({ tone: 'ok', text: active ? 'Campaign resumed — ads are live on Facebook again.' : 'Campaign paused — ad delivery (and spend) is stopped. Resume anytime.' });
    } catch (err) {
      setNote({ tone: 'err', text: err instanceof ApiError ? err.message : 'Could not change campaign status.' });
    } finally {
      setToggling(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {LIVE_TOGGLEABLE.has(c.status) && (
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
            {c.status === 'ACTIVE' ? (
              <>
                <strong>Live on Facebook</strong> — ads are delivering. Pause to stop delivery + spend without losing the campaign; resume anytime.
              </>
            ) : (
              <>
                <strong>Paused</strong> — ads are not delivering on Facebook. Resume to put them back live.
              </>
            )}
          </div>
          <div style={{ flexShrink: 0 }}>
            {c.status === 'ACTIVE' ? (
              <Button variant="danger" onClick={() => void toggleActive(false)} loading={toggling}>
                {toggling ? 'Pausing…' : 'Pause campaign'}
              </Button>
            ) : (
              <Button onClick={() => void toggleActive(true)} loading={toggling}>
                {toggling ? 'Resuming…' : 'Resume campaign'}
              </Button>
            )}
          </div>
        </div>
      )}
      {REOPENABLE.has(c.status) && (
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
            {c.status === 'QUEUED_NO_CHANNEL' ? (
              <>
                <strong>Waiting for a channel</strong> — no AdSense channel is free for this campaign yet. Reopen to edit it, or leave it queued.
              </>
            ) : (
              <>
                <strong>{c.status === 'BATCHED' ? 'Rate-limited' : 'Ready to publish'}</strong> — a channel is assigned. Launching generates the article, wires the
                redirect, and creates the ads on Facebook. Need to fix something first? Reopen to edit.
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.6rem', flexShrink: 0 }}>
            <Button variant="ghost" onClick={() => void reopen()} loading={reopening} disabled={launching}>
              {reopening ? 'Reopening…' : 'Reopen & edit'}
            </Button>
            {/* Manual launch is available to the campaign owner (buyer) and admins alike —
                the API owner-scopes it. Approval stays admin-only; launch ≠ approval. */}
            {LAUNCHABLE.has(c.status) && (
              <Button onClick={() => void launch()} loading={launching} disabled={reopening}>
                {launching ? 'Launching…' : 'Launch to Facebook'}
              </Button>
            )}
          </div>
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
