'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Banner, Button, Card, EmptyState, Skeleton, useConfirm, useToast } from '@/components/ui';
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

/** Minimum characters for a rejection reason shown to the buyer. */
const REASON_MIN = 10;
const REASON_MAX = 500;

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

function whenLabel(iso: string): string {
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

  const toast = useToast();
  const confirm = useConfirm();

  const [pending, setPending] = useState<Campaign[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [org, setOrg] = useState<AdminOrg | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [togglingLaunch, setTogglingLaunch] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const load = useCallback(() => {
    setLoadError(false);
    void campaignsApi
      .pending()
      .then(setPending)
      .catch(() => {
        setPending([]);
        setLoadError(true);
      });
    void adminApi
      .organization()
      .then(setOrg)
      .catch(() => setOrg(null));
  }, []);

  useEffect(load, [load]);

  function drop(id: string) {
    setPending((prev) => prev?.filter((c) => c.id !== id) ?? prev);
  }

  async function approve(c: Campaign) {
    const autoLaunch = org?.autoLaunch ?? false;
    const ok = await confirm({
      title: `Approve “${c.name}”?`,
      body: (
        <>
          Daily budget <b>{money(dailyBudgetCents(c))}</b>. Approving assigns this campaign a finite
          AdSense channel from the shared pool.
          {autoLaunch
            ? ' Auto-launch is on — approving will launch live Facebook ads immediately and start spending budget.'
            : ' It will then wait for a manual launch before any Facebook spend.'}
        </>
      ),
      confirmLabel: 'Approve',
    });
    if (!ok) return;

    setBusyId(c.id);
    try {
      await campaignsApi.approve(c.id);
      drop(c.id);
      toast.success(`Approved “${c.name}”.`);
    } catch {
      toast.error('Could not approve this campaign. It may have already been reviewed.');
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function confirmReject(c: Campaign) {
    const text = reason.trim();
    if (text.length < REASON_MIN) return;
    setBusyId(c.id);
    try {
      await campaignsApi.reject(c.id, text);
      drop(c.id);
      setRejectingId(null);
      setReason('');
      toast.success(`Rejected “${c.name}” — the buyer has been notified.`);
    } catch {
      toast.error('Could not reject this campaign. It may have already been reviewed.');
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
      toast.success(
        updated.autoApprove ? 'Auto-approve turned on.' : 'Auto-approve turned off — submissions now wait for review.',
      );
    } catch {
      toast.error('Could not change the approval mode.');
    } finally {
      setTogglingAuto(false);
    }
  }

  async function toggleLaunch() {
    if (!org) return;
    const next = !org.autoLaunch;
    // Enabling auto-launch is a spend-incurring change; gate it behind a confirm.
    // Disabling it is safe and stays single-click.
    if (next) {
      const ok = await confirm({
        title: 'Turn on auto-launch?',
        body: (
          <>
            Approved campaigns will <b>immediately launch live Facebook ads and start spending budget</b> with
            no manual launch step. You can turn this off again at any time.
          </>
        ),
        confirmLabel: 'Turn on auto-launch',
      });
      if (!ok) return;
    }
    setTogglingLaunch(true);
    try {
      const updated = await adminApi.setAutoLaunch(org.id, next);
      setOrg(updated);
      toast.success(
        updated.autoLaunch
          ? 'Auto-launch turned on — approved campaigns go live automatically.'
          : 'Auto-launch turned off — approved campaigns wait for a manual launch.',
      );
    } catch {
      toast.error('Could not change the launch mode.');
    } finally {
      setTogglingLaunch(false);
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
          <div className={styles.modes}>
            <div className={styles.mode}>
              <div className={styles.modeText}>
                <span className={styles.modeLabel}>Auto-approve</span>
                <span className={styles.modeHint}>
                  {org.autoApprove ? 'Submissions skip manual review' : 'Submissions wait for manual review'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={org.autoApprove}
                aria-label="Toggle auto-approve"
                aria-busy={togglingAuto}
                className={`${styles.toggle} ${org.autoApprove ? styles.toggleOn : ''}`}
                disabled={togglingAuto}
                onClick={() => void toggleAuto()}
              >
                <span className={styles.knob} />
              </button>
            </div>

            <div className={styles.mode}>
              <div className={styles.modeText}>
                <span className={styles.modeLabel}>Auto-launch</span>
                <span className={styles.modeHint}>
                  {org.autoLaunch
                    ? 'Approved campaigns launch to Facebook automatically'
                    : 'Approved campaigns wait for a manual launch'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={org.autoLaunch}
                aria-label="Toggle auto-launch"
                aria-busy={togglingLaunch}
                className={`${styles.toggle} ${org.autoLaunch ? styles.toggleOn : ''}`}
                disabled={togglingLaunch}
                onClick={() => void toggleLaunch()}
              >
                <span className={styles.knob} />
              </button>
            </div>
          </div>
        )}
      </div>

      {loadError && (
        <div className={styles.loadError}>
          <Banner
            tone="error"
            title="Couldn’t load the review queue"
            action={
              <Button variant="secondary" onClick={load}>
                Retry
              </Button>
            }
          >
            Something went wrong fetching pending campaigns.
          </Banner>
        </div>
      )}

      {pending === null ? (
        <div className={styles.list} aria-busy="true" aria-label="Loading campaigns">
          {[0, 1, 2].map((i) => (
            <Card key={i} className={styles.card}>
              <div className={styles.cardTop}>
                <Skeleton className={styles.skName} />
                <Skeleton className={styles.skWhen} />
              </div>
              <div className={styles.skMeta}>
                <Skeleton className={styles.skLine} />
                <Skeleton className={styles.skLineShort} />
              </div>
              <div className={styles.skActions}>
                <Skeleton className={styles.skBtn} />
                <Skeleton className={styles.skBtn} />
              </div>
            </Card>
          ))}
        </div>
      ) : pending.length === 0 ? (
        <Card>
          <EmptyState
            icon={<span aria-hidden>📥</span>}
            title="Nothing to review"
            description="Campaigns submitted by your media buyers will appear here for approval."
            action={
              <Link href="/dashboard/campaigns" className={styles.emptyLink}>
                View all campaigns
              </Link>
            }
          />
        </Card>
      ) : (
        <div className={styles.list}>
          {pending.map((c) => {
            const cc = countries(c);
            const busy = busyId === c.id;
            const trimmed = reason.trim();
            const reasonValid = trimmed.length >= REASON_MIN;
            const restricted = c.specialAdCategories.length > 0;
            return (
              <Card key={c.id} className={`${styles.card} ${restricted ? styles.cardRestricted : ''}`}>
                <div className={styles.cardTop}>
                  <div className={styles.cardHead}>
                    <span className={styles.cardName}>{c.name}</span>
                    <Link href={`/dashboard/campaigns/${c.id}`} className={styles.viewLink}>
                      View campaign
                    </Link>
                  </div>
                  {c.submittedAt && (
                    <span className={styles.cardWhen}>Submitted {whenLabel(c.submittedAt)}</span>
                  )}
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
                  {c.racValue && (
                    <span>
                      RAC <b>{c.racValue}</b>
                    </span>
                  )}
                  {cc.length > 0 &&
                    (() => {
                      const geoKey = `${c.id}:geo`;
                      const geoOpen = expanded.has(geoKey);
                      const hiddenGeos = cc.slice(6);
                      return (
                        <span>
                          Geo <b>{(geoOpen ? cc : cc.slice(0, 6)).join(', ')}</b>
                          {hiddenGeos.length > 0 && (
                            <button
                              type="button"
                              className={styles.moreBtn}
                              title={hiddenGeos.join(', ')}
                              aria-expanded={geoOpen}
                              onClick={() => toggleExpanded(geoKey)}
                            >
                              {geoOpen ? ' show less' : ` +${hiddenGeos.length}`}
                            </button>
                          )}
                        </span>
                      );
                    })()}
                </div>

                {c.keywords.length > 0 &&
                  (() => {
                    const kwKey = `${c.id}:kw`;
                    const kwOpen = expanded.has(kwKey);
                    const hiddenKeywords = c.keywords.slice(8);
                    const shown = kwOpen ? c.keywords : c.keywords.slice(0, 8);
                    return (
                      <div className={styles.chips}>
                        {shown.map((k) => (
                          <span key={k} className={styles.chip}>
                            {k}
                          </span>
                        ))}
                        {hiddenKeywords.length > 0 && (
                          <button
                            type="button"
                            className={`${styles.chip} ${styles.chipMore}`}
                            title={hiddenKeywords.join(', ')}
                            aria-expanded={kwOpen}
                            onClick={() => toggleExpanded(kwKey)}
                          >
                            {kwOpen ? 'Show less' : `+${hiddenKeywords.length} more`}
                          </button>
                        )}
                      </div>
                    );
                  })()}

                {restricted && (
                  <div className={styles.restricted}>
                    <span className={styles.restrictedLabel}>
                      Special ad categories — restricted targeting applies
                    </span>
                    <div className={styles.badges}>
                      {c.specialAdCategories.map((s) => (
                        <Badge key={s} tone="warning" dot>
                          {s.replace(/_/g, ' ')}
                        </Badge>
                      ))}
                    </div>
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
                      maxLength={REASON_MAX}
                      minLength={REASON_MIN}
                      aria-describedby={`reason-help-${c.id}`}
                      placeholder="e.g. Landing page needs a clearer disclaimer before launch."
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <div className={styles.reasonMeta} id={`reason-help-${c.id}`}>
                      <span className={reasonValid ? styles.reasonOk : styles.reasonNeed}>
                        {reasonValid
                          ? 'Looks good.'
                          : `At least ${REASON_MIN} characters (${trimmed.length}/${REASON_MIN}).`}
                      </span>
                      <span className={styles.reasonCount}>
                        {reason.length}/{REASON_MAX}
                      </span>
                    </div>
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
                        variant="danger-solid"
                        loading={busy}
                        disabled={!reasonValid}
                        onClick={() => void confirmReject(c)}
                      >
                        Confirm rejection
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.actions}>
                    <Button loading={busy} onClick={() => void approve(c)}>
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
