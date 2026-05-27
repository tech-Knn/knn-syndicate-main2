'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Spinner } from '@/components/ui';
import { admin as adminApi, campaigns as campaignsApi } from '@/lib/api';
import { type AdminOrg, type Campaign } from '@/lib/types';
import { useAuth } from '../../providers';
import styles from './approvals.module.css';

const OBJECTIVE_LABEL: Record<string, string> = {
  OUTCOME_SALES: 'Sales',
  OUTCOME_LEADS: 'Leads',
  OUTCOME_TRAFFIC: 'Traffic',
  OUTCOME_ENGAGEMENT: 'Engagement',
  OUTCOME_AWARENESS: 'Awareness',
  OUTCOME_APP_PROMOTION: 'App promotion',
};

function objectiveLabel(o: string): string {
  return OBJECTIVE_LABEL[o] ?? o.replace(/^OUTCOME_/, '').toLowerCase();
}

function dailyBudgetCents(c: Campaign): number {
  if (c.budgetMode === 'CAMPAIGN') return c.dailyBudgetCents ?? 0;
  return c.adSets.reduce((sum, s) => sum + (s.dailyBudgetCents ?? 0), 0);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function countAds(c: Campaign): number {
  return c.adSets.reduce((n, s) => n + s.ads.length, 0);
}

function countries(c: Campaign): string[] {
  return [...new Set(c.adSets.flatMap((s) => s.countries))];
}

function whenLabel(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function ApprovalsPage() {
  const { user } = useAuth();
  const isCompanyAdmin = user?.role === 'COMPANY_ADMIN';

  const [pending, setPending] = useState<Campaign[] | null>(null);
  const [org, setOrg] = useState<AdminOrg | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [togglingAuto, setTogglingAuto] = useState(false);

  const load = useCallback(() => {
    void campaignsApi
      .pending()
      .then(setPending)
      .catch(() => setPending([]));
    void adminApi
      .organization()
      .then(setOrg)
      .catch(() => setOrg(null));
  }, []);

  useEffect(load, [load]);

  function drop(id: string) {
    setPending((prev) => prev?.filter((c) => c.id !== id) ?? prev);
  }

  async function approve(id: string) {
    setBusyId(id);
    try {
      await campaignsApi.approve(id);
      drop(id);
    } catch {
      window.alert('Could not approve this campaign. It may have already been reviewed.');
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function confirmReject(id: string) {
    const text = reason.trim();
    if (!text) return;
    setBusyId(id);
    try {
      await campaignsApi.reject(id, text);
      drop(id);
      setRejectingId(null);
      setReason('');
    } catch {
      window.alert('Could not reject this campaign. It may have already been reviewed.');
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function toggleAuto() {
    if (!org) return;
    setTogglingAuto(true);
    try {
      const updated = await adminApi.setAutoApprove(org.id, !org.autoApprove);
      setOrg(updated);
    } catch {
      window.alert('Could not change the approval mode.');
    } finally {
      setTogglingAuto(false);
    }
  }

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={`serif ${styles.title}`}>Approvals</h1>
          <p className={styles.subtitle}>Review submitted campaigns before they launch to Facebook.</p>
        </div>

        {isCompanyAdmin && org && (
          <div className={styles.mode}>
            <div className={styles.modeText}>
              <span className={styles.modeLabel}>Auto-approve</span>
              <span className={styles.modeHint}>
                {org.autoApprove ? 'Submissions launch without review' : 'Submissions wait for manual review'}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={org.autoApprove}
              aria-label="Toggle auto-approve"
              className={`${styles.toggle} ${org.autoApprove ? styles.toggleOn : ''}`}
              disabled={togglingAuto}
              onClick={() => void toggleAuto()}
            >
              <span className={styles.knob} />
            </button>
          </div>
        )}
      </div>

      {pending === null ? (
        <Card className={styles.center}>
          <Spinner />
        </Card>
      ) : pending.length === 0 ? (
        <Card className={styles.empty}>
          <h2 className={styles.emptyTitle}>Nothing to review</h2>
          <p className={styles.emptyText}>
            Campaigns submitted by your media buyers will appear here for approval.
          </p>
        </Card>
      ) : (
        <div className={styles.list}>
          {pending.map((c) => {
            const cc = countries(c);
            const busy = busyId === c.id;
            return (
              <Card key={c.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.cardName}>{c.name}</span>
                  <span className={styles.cardWhen}>Submitted {whenLabel(c.submittedAt)}</span>
                </div>

                <div className={styles.metaRow}>
                  <span>
                    Objective <b>{objectiveLabel(c.objective)}</b>
                  </span>
                  <span>
                    <b>{c.adSets.length}</b> ad set{c.adSets.length === 1 ? '' : 's'} · <b>{countAds(c)}</b> ad
                    {countAds(c) === 1 ? '' : 's'}
                  </span>
                  <span>
                    <b>{money(dailyBudgetCents(c))}</b>/day ({c.budgetMode === 'CAMPAIGN' ? 'CBO' : 'ABO'})
                  </span>
                  {cc.length > 0 && (
                    <span>
                      Geo <b>{cc.slice(0, 6).join(', ')}</b>
                      {cc.length > 6 ? ` +${cc.length - 6}` : ''}
                    </span>
                  )}
                </div>

                {c.keywords.length > 0 && (
                  <div className={styles.chips}>
                    {c.keywords.slice(0, 8).map((k) => (
                      <span key={k} className={styles.chip}>
                        {k}
                      </span>
                    ))}
                    {c.keywords.length > 8 && <span className={styles.chip}>+{c.keywords.length - 8}</span>}
                  </div>
                )}

                {c.specialAdCategories.length > 0 && (
                  <div className={styles.badges}>
                    {c.specialAdCategories.map((s) => (
                      <Badge key={s} tone="warning">
                        {s.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                  </div>
                )}

                {rejectingId === c.id ? (
                  <div className={styles.rejectBox}>
                    <label className={styles.reasonLabel} htmlFor={`reason-${c.id}`}>
                      Reason for rejection (shown to the buyer)
                    </label>
                    <textarea
                      id={`reason-${c.id}`}
                      className={styles.textarea}
                      value={reason}
                      autoFocus
                      placeholder="e.g. Landing page needs a clearer disclaimer before launch."
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <div className={styles.rejectActions}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setRejectingId(null);
                          setReason('');
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
                        loading={busy}
                        disabled={!reason.trim()}
                        onClick={() => void confirmReject(c.id)}
                      >
                        Confirm rejection
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.actions}>
                    <Button loading={busy} onClick={() => void approve(c.id)}>
                      Approve
                    </Button>
                    <div className={styles.spacer} />
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setRejectingId(c.id);
                        setReason('');
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
