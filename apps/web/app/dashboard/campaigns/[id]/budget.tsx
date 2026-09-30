'use client';

import { useEffect, useState } from 'react';
import { Button, useToast } from '@/components/ui';
import { ApiError, campaigns } from '@/lib/api';
import type { Campaign, CampaignAdSet } from '@/lib/types';
import styles from './campaign.module.css';
import { minBudgetCents, minBudgetMessage, networkName } from './status';

/** The campaign's effective daily budget (cents) + whether it's live-editable here. CBO → the
 *  campaign budget; single-ad-set ABO → that ad set's budget; multi-ad-set ABO → edit per ad set. */
export function liveBudget(c: Campaign): { cents: number | null; editable: boolean; perAdSet: boolean } {
  if (c.budgetMode === 'CAMPAIGN') return { cents: c.dailyBudgetCents, editable: true, perAdSet: false };
  const sets = c.adSets ?? [];
  if (sets.length === 1) return { cents: sets[0]!.dailyBudgetCents, editable: true, perAdSet: false };
  return { cents: null, editable: false, perAdSet: true };
}

const dollars = (cents: number | null): string => (cents != null ? (cents / 100).toFixed(2) : '');

/** One budget amount with a Save button and ±scale shortcuts. Used for the campaign and, in ABO, for each ad set. */
function BudgetEditor({
  campaign,
  cents,
  label,
  editable,
  onCommit,
}: {
  campaign: Campaign;
  cents: number | null;
  label: string;
  editable: boolean;
  onCommit: (nextCents: number) => Promise<void>;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<string>(dollars(cents));
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(dollars(cents)), [cents]);

  const commit = async (nextCents: number): Promise<void> => {
    const rounded = Math.round(nextCents);
    if (!Number.isFinite(rounded) || rounded < minBudgetCents(campaign)) {
      toast.error(minBudgetMessage(campaign));
      return;
    }
    if (rounded === cents) return; // no-op: don't spend a write at the ad network
    setBusy(true);
    try {
      await onCommit(rounded);
    } finally {
      setBusy(false);
    }
  };
  const bump = (factor: number): void => void commit(Math.max(minBudgetCents(campaign), (cents ?? 0) * factor));

  // What is typed, read the way Save will read it: anything that is not a usable amount stops here, with the reason.
  const typed = Math.round(Number(draft) * 100);
  const invalid = draft.trim() === '' || !Number.isFinite(typed) || typed < minBudgetCents(campaign);
  const unchanged = typed === cents;

  return (
    <>
    <div className={styles.budgetRow}>
      <div className={styles.moneyInput}>
        <span aria-hidden>$</span>
        <input
          type="number"
          min={campaign.adProvider === 'WHOP' ? 0.01 : 2}
          step="0.01"
          value={draft}
          disabled={!editable || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !invalid && void commit(typed)}
          aria-label={`Daily budget${label ? ` for ${label}` : ''} in dollars`}
          aria-invalid={invalid && draft !== dollars(cents) ? true : undefined}
        />
      </div>
      <Button onClick={() => void commit(typed)} loading={busy} disabled={!editable || invalid || unchanged}>
        Save
      </Button>
      <div className={styles.quick} role="group" aria-label={`Quick budget scaling${label ? ` for ${label}` : ''}`}>
        <Button variant="ghost" onClick={() => bump(0.8)} disabled={!editable || busy} title="Cut 20%">
          −20%
        </Button>
        <Button variant="ghost" onClick={() => bump(1.2)} disabled={!editable || busy} title="Scale 20%">
          +20%
        </Button>
        <Button variant="ghost" onClick={() => bump(1.5)} disabled={!editable || busy} title="Scale 50%">
          +50%
        </Button>
      </div>
    </div>
    {editable && invalid && draft !== dollars(cents) && (
      <p className={styles.fieldError} role="alert">
        {minBudgetMessage(campaign)}
      </p>
    )}
    </>
  );
}

/**
 * Live budget editor (the daily-driver action): change a launched campaign's daily budget and push it to the ad
 * network instantly, WITHOUT releasing the AdSense channel or re-queuing for approval.
 */
export function LiveBudget({ campaign, onSaved }: { campaign: Campaign; onSaved: (next: { adSetId?: string; cents: number }) => void }) {
  const toast = useToast();
  const { cents, editable, perAdSet } = liveBudget(campaign);
  const net = networkName(campaign);
  const fail = (err: unknown): void => toast.error(err instanceof ApiError ? err.message : 'Could not update the budget.');

  if (perAdSet) {
    const sets: CampaignAdSet[] = campaign.adSets ?? [];
    const total = sets.reduce((sum, s) => sum + (s.dailyBudgetCents ?? 0), 0);
    const rowsEditable = campaign.status === 'ACTIVE' || campaign.status === 'PAUSED';
    return (
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div>
            <h3 className={styles.panelTitle}>Daily budget</h3>
            <p className={styles.panelSub}>Each ad set has its own budget. Saving pushes to {net} instantly, with no channel release and no re-review.</p>
          </div>
        </div>
        <div className={styles.budget}>
          {sets.map((set, i) => {
            const label = set.name || `Ad set ${i + 1}`;
            return (
              <div key={set.id} className={styles.budgetSet}>
                <span className={styles.budgetName}>{label}</span>
                <BudgetEditor
                  campaign={campaign}
                  cents={set.dailyBudgetCents}
                  label={label}
                  editable={rowsEditable}
                  onCommit={async (next) => {
                    try {
                      const res = await campaigns.setAdSetBudget(campaign.id, set.id, next);
                      onSaved({ adSetId: set.id, cents: res.dailyBudgetCents });
                      toast.success(`${label}: daily budget set to $${(res.dailyBudgetCents / 100).toFixed(2)}, live on ${net}.`);
                    } catch (err) {
                      fail(err);
                    }
                  }}
                />
              </div>
            );
          })}
          <div className={styles.budgetTotal}>
            <span>Total daily budget</span>
            <strong>
              ${(total / 100).toFixed(2)} / day across {sets.length} ad sets
            </strong>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h3 className={styles.panelTitle}>Daily budget</h3>
          <p className={styles.panelSub}>Pushes to {net} instantly, with no channel release and no re-review.</p>
        </div>
      </div>
      <BudgetEditor
        campaign={campaign}
        cents={cents}
        label=""
        editable={editable}
        onCommit={async (next) => {
          try {
            const res = await campaigns.setBudget(campaign.id, next);
            onSaved({ cents: res.dailyBudgetCents });
            toast.success(`Daily budget set to $${(res.dailyBudgetCents / 100).toFixed(2)}, live on ${net}.`);
          } catch (err) {
            fail(err);
          }
        }}
      />
    </section>
  );
}
