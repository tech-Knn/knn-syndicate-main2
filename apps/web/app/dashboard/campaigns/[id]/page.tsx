'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { CampaignWizard } from '@/components/campaign-wizard';
import { ApiError, campaigns } from '@/lib/api';
import { Banner, Button, Card, Spinner, useConfirm, useToast } from '@/components/ui';
import { type Campaign } from '@/lib/types';
import { OffersEditor } from './offers-editor';

/** The campaign's effective daily budget (cents) + whether it's live-editable here. CBO → the
 *  campaign budget; single-ad-set ABO → that ad set's budget; multi-ad-set ABO → edit per ad set. */
function liveBudget(c: Campaign): { cents: number | null; editable: boolean; perAdSet: boolean } {
  if (c.budgetMode === 'CAMPAIGN') return { cents: c.dailyBudgetCents, editable: true, perAdSet: false };
  const sets = c.adSets ?? [];
  if (sets.length === 1) return { cents: sets[0]!.dailyBudgetCents, editable: true, perAdSet: false };
  return { cents: null, editable: false, perAdSet: true };
}

/**
 * Live budget editor (the M1 daily-driver action) — change a launched campaign's daily budget and
 * push it to Facebook instantly, WITHOUT releasing the AdSense channel or re-queuing for approval.
 * Quick ±/scale buttons make trimming a loser / scaling a winner a one-click move.
 */
function LiveBudget({ campaign, onSaved }: { campaign: Campaign; onSaved: (cents: number) => void }) {
  const toast = useToast();
  const { cents, editable, perAdSet } = liveBudget(campaign);
  const [draft, setDraft] = useState<string>(cents != null ? (cents / 100).toFixed(2) : '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(cents != null ? (cents / 100).toFixed(2) : '');
  }, [cents]);

  const commit = async (nextCents: number): Promise<void> => {
    const rounded = Math.round(nextCents);
    if (!Number.isFinite(rounded) || rounded < 200) {
      toast.error('Minimum daily budget is $2.00 (Facebook minimum).');
      return;
    }
    setBusy(true);
    try {
      const res = await campaigns.setBudget(campaign.id, rounded);
      onSaved(res.dailyBudgetCents);
      toast.success(`Daily budget set to $${(res.dailyBudgetCents / 100).toFixed(2)} — live on Facebook.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the budget.');
    } finally {
      setBusy(false);
    }
  };

  if (perAdSet) {
    return (
      <Card style={{ padding: '0.9rem 1.1rem' }}>
        <strong style={{ color: 'var(--cream)' }}>Daily budget</strong>{' '}
        <span style={{ color: 'var(--muted)' }}>— this campaign uses per-ad-set budgets across multiple ad sets; edit each ad set individually (coming soon).</span>
      </Card>
    );
  }

  const bump = (factor: number): void => void commit(Math.max(200, (cents ?? 0) * factor));

  return (
    <Card style={{ padding: '0.9rem 1.1rem', display: 'flex', alignItems: 'center', gap: '0.9rem', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--muted)' }}>DAILY BUDGET</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--muted-2)' }}>Pushes to Facebook instantly — no channel release, no re-review.</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{ color: 'var(--muted)' }}>$</span>
        <input
          type="number"
          min={2}
          step="0.01"
          value={draft}
          disabled={!editable || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void commit(Math.round(Number(draft) * 100))}
          aria-label="Daily budget in dollars"
          style={{ width: '6.5rem', background: 'var(--bg)', border: '1px solid var(--border-interactive)', borderRadius: 'var(--radius-sm)', color: 'var(--cream)', padding: '0.5rem 0.6rem', fontSize: '0.95rem' }}
        />
        <Button onClick={() => void commit(Math.round(Number(draft) * 100))} loading={busy} disabled={!editable}>
          Save
        </Button>
      </div>
      <div style={{ display: 'flex', gap: '0.35rem' }} aria-label="Quick budget scaling">
        <Button variant="ghost" onClick={() => bump(0.8)} disabled={!editable || busy} title="Cut 20%">−20%</Button>
        <Button variant="ghost" onClick={() => bump(1.2)} disabled={!editable || busy} title="Scale 20%">+20%</Button>
        <Button variant="ghost" onClick={() => bump(1.5)} disabled={!editable || busy} title="Scale 50%">+50%</Button>
      </div>
    </Card>
  );
}

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
  const toast = useToast();
  const confirm = useConfirm();
  const [campaign, setCampaign] = useState<Campaign | null | 'error'>(null);
  const [launching, setLaunching] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);

  const load = useCallback(() => {
    void campaigns
      .get(id)
      .then((c) => setCampaign(c))
      .catch(() => setCampaign('error'));
  }, [id]);
  useEffect(() => load(), [load]);

  if (campaign === 'error') {
    return <Banner tone="error" title="Campaign not found">We couldn’t load this campaign. It may have been deleted or you don’t have access.</Banner>;
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
      setNote({ tone: 'success', text: res.fbCampaignId ? `Sent to Facebook — status: ${res.status}.` : `Launch queued — status: ${res.status}.` });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Launch failed.');
    } finally {
      setLaunching(false);
    }
  };

  const reopen = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Reopen for editing?',
      body: 'This returns the campaign to a draft and releases its assigned channel back to the pool. You can resubmit when you are done.',
      confirmLabel: 'Reopen',
    });
    if (!ok) return;
    setReopening(true);
    setNote(null);
    try {
      const updated = await campaigns.reopen(c.id);
      setCampaign(updated);
      setNote({ tone: 'success', text: 'Campaign reopened — it\'s now an editable draft. Make your changes and submit again.' });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Reopen failed.');
    } finally {
      setReopening(false);
    }
  };

  const toggleActive = async (active: boolean): Promise<void> => {
    // Pausing is destructive (stops live delivery + spend) — confirm first.
    // Resuming is non-destructive, so it stays single-click.
    if (!active) {
      const ok = await confirm({
        title: 'Pause this campaign?',
        body: 'Pausing stops live delivery on Facebook and halts ad spend. You can resume anytime.',
        confirmLabel: 'Pause campaign',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setToggling(true);
    setNote(null);
    try {
      const res = active ? await campaigns.resume(c.id) : await campaigns.pause(c.id);
      setCampaign({ ...c, status: res.status as Campaign['status'] });
      setNote({ tone: 'success', text: active ? 'Campaign resumed — ads are live on Facebook again.' : 'Campaign paused — ad delivery (and spend) is stopped. Resume anytime.' });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change campaign status.');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {LIVE_TOGGLEABLE.has(c.status) &&
        (c.status === 'ACTIVE' ? (
          <Banner
            tone="info"
            title="Live on Facebook"
            action={
              <Button variant="danger" onClick={() => void toggleActive(false)} loading={toggling}>
                {toggling ? 'Pausing…' : 'Pause campaign'}
              </Button>
            }
          >
            Ads are delivering. Pause to stop delivery + spend without losing the campaign; resume anytime.
          </Banner>
        ) : (
          <Banner
            tone="warning"
            title="Paused"
            action={
              <Button onClick={() => void toggleActive(true)} loading={toggling}>
                {toggling ? 'Resuming…' : 'Resume campaign'}
              </Button>
            }
          >
            Ads are not delivering on Facebook. Resume to put them back live.
          </Banner>
        ))}
      {REOPENABLE.has(c.status) && (
        <Banner
          tone={c.status === 'QUEUED_NO_CHANNEL' ? 'warning' : 'info'}
          title={
            c.status === 'QUEUED_NO_CHANNEL'
              ? 'Waiting for a channel'
              : c.status === 'BATCHED'
                ? 'Rate-limited'
                : 'Ready to publish'
          }
          action={
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
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
          }
        >
          {c.status === 'QUEUED_NO_CHANNEL'
            ? 'No AdSense channel is free for this campaign yet. Reopen to edit it, or leave it queued.'
            : 'A channel is assigned. Launching generates the article, wires the redirect, and creates the ads on Facebook. Need to fix something first? Reopen to edit.'}
        </Banner>
      )}
      {note && (
        <Banner tone={note.tone} onDismiss={() => setNote(null)}>
          {note.text}
        </Banner>
      )}
      {LIVE_TOGGLEABLE.has(c.status) && (
        <LiveBudget
          campaign={c}
          onSaved={(cents) =>
            setCampaign((prev) =>
              !prev || prev === 'error'
                ? prev
                : prev.budgetMode === 'CAMPAIGN'
                  ? { ...prev, dailyBudgetCents: cents }
                  : { ...prev, adSets: prev.adSets.map((s, i) => (i === 0 ? { ...s, dailyBudgetCents: cents } : s)) },
            )
          }
        />
      )}
      <CampaignWizard campaign={c} />
      <OffersEditor campaignId={c.id} status={c.status} />
    </div>
  );
}
