'use client';

import { useEffect, useState } from 'react';
import { formatUsd } from '@knn/shared';
import admin from '../admin.module.css';
import styles from '../analytics.module.css';

/**
 * Inline daily-budget cell — shows the campaign's daily budget right in the table and lets a buyer
 * edit it in place (click → type → Enter / blur saves, Esc cancels) without drilling into the campaign.
 * Editable only when live (ACTIVE/PAUSED) and CBO or a single ad set — matching the server's rule;
 * the save pushes to the campaign's ad network (Facebook or Whop) without releasing the channel. Read-only
 * ("$X.XX" / "—") otherwise. `minCents` is the network's floor: Facebook's is $2.00, Whop states its own.
 */
export function BudgetCell({
  cents: centsProp,
  editable,
  label,
  save,
  onSaved,
  onError,
  emptyLabel = '—',
  minCents = 200,
}: {
  cents: number | null;
  editable: boolean;
  label: string;
  save: (cents: number) => Promise<{ dailyBudgetCents: number }>;
  onSaved?: (cents: number) => void;
  onError: (msg: string) => void;
  /** Shown when there's no single editable budget (e.g. multi-ad-set ABO → "Per ad set"). */
  emptyLabel?: string;
  /** The smallest budget to accept, in cents (Facebook 200; Whop 1, it enforces its own). */
  minCents?: number;
}) {
  const [current, setCurrent] = useState(centsProp);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setCurrent(centsProp), [centsProp]);

  const display = current != null ? formatUsd(current / 100) : emptyLabel;
  if (!editable) return <span className={current == null && emptyLabel !== '—' ? admin.subtle : undefined}>{display}</span>;

  const start = (): void => {
    setDraft(((current ?? 0) / 100).toFixed(2));
    setEditing(true);
  };
  const commit = async (): Promise<void> => {
    const c = Math.round(Number(draft) * 100);
    if (!Number.isFinite(c) || c === current) {
      setEditing(false);
      return;
    }
    if (c < minCents) {
      onError(minCents <= 1 ? 'Enter a daily budget of at least $0.01.' : 'Minimum daily budget is $2.00 (Facebook minimum).');
      return;
    }
    setBusy(true);
    try {
      const res = await save(c);
      setCurrent(res.dailyBudgetCents);
      onSaved?.(res.dailyBudgetCents);
      setEditing(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not update the budget.');
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1, justifyContent: 'flex-end' }}>
        <span style={{ color: 'var(--muted)' }}>$</span>
        <input
          autoFocus
          type="number"
          min={minCents / 100}
          step="0.01"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={() => void commit()}
          aria-label={`Daily budget for ${label}`}
          style={{ width: '4.6rem', background: 'var(--bg)', border: '1px solid var(--rust)', borderRadius: 'var(--radius-sm)', color: 'var(--cream)', padding: '0.25rem 0.4rem', fontSize: '0.85rem', textAlign: 'right' }}
        />
      </span>
    );
  }
  return (
    <button type="button" className={styles.budgetEdit} onClick={start} title="Click to edit daily budget">
      {display}
    </button>
  );
}
