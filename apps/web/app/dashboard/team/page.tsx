'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  type BuyerRollup,
  addBusinessDays,
  currentBusinessDay,
  formatUsd,
} from '@knn/shared';
import { Badge, Card, type DateRange, DateRangePicker, Skeleton, useConfirm, useToast } from '@/components/ui';
import { admin, stats } from '@/lib/api';
import { type PublicUser, type UserAction } from '@/lib/types';
import { useAuth } from '../../providers';
import styles from '../admin.module.css';

function rangeFor(days: number): DateRange {
  const to = currentBusinessDay();
  return { from: addBusinessDays(to, -(days - 1)), to };
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  ACTIVE: 'success',
  PENDING: 'warning',
  SUSPENDED: 'neutral',
  REJECTED: 'danger',
};

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Platform',
  COMPANY_ADMIN: 'Admin',
  MEDIA_BUYER: 'Buyer',
};

function actionsFor(status: string): { label: string; action: UserAction; danger?: boolean }[] {
  switch (status) {
    case 'PENDING':
      return [
        { label: 'Approve', action: 'approve' },
        { label: 'Reject', action: 'reject', danger: true },
      ];
    case 'ACTIVE':
      return [{ label: 'Suspend', action: 'suspend', danger: true }];
    case 'SUSPENDED':
    case 'REJECTED':
      return [{ label: 'Reactivate', action: 'reactivate' }];
    default:
      return [];
  }
}

export default function TeamPage() {
  const { user } = useAuth();
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [range, setRange] = useState<DateRange>(() => rangeFor(30));
  const [buyers, setBuyers] = useState<BuyerRollup[] | null>(null);
  const [members, setMembers] = useState<PublicUser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (user && user.role !== 'COMPANY_ADMIN' && user.role !== 'SUPER_ADMIN') router.replace('/dashboard');
  }, [user, router]);

  const loadBuyers = useCallback(async (r: DateRange) => {
    setBuyers(null);
    try {
      setBuyers(await stats.byBuyer(r));
    } catch {
      setBuyers([]);
    }
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      setMembers(await admin.users());
    } catch {
      setMembers([]);
    }
  }, []);

  useEffect(() => {
    void loadBuyers(range);
  }, [range, loadBuyers]);
  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const act = async (id: string, action: UserAction): Promise<void> => {
    setBusy(id);
    try {
      await admin.setUserStatus(id, action);
      await loadMembers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the member.');
    } finally {
      setBusy(null);
    }
  };

  // Super-admin only: permanently delete a user (frees their email for re-use).
  const remove = async (m: PublicUser): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${m.name}?`,
      body: `Permanently delete ${m.name} (${m.email})? This cannot be undone and frees their email to re-use.`,
      confirmLabel: 'Delete user',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(m.id);
    try {
      await admin.deleteUser(m.id);
      await loadMembers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the user.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Team</span>
          <h1 className={`serif ${styles.title}`}>Your organization</h1>
          <p className={styles.sub}>Manage members and see performance by buyer.</p>
        </div>
      </div>

      {/* Revenue by buyer */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Performance by buyer</span>
          <DateRangePicker value={range} onChange={setRange} />
        </div>
        {!buyers ? (
          <div className={styles.rowsSkel}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className={styles.rowSkel} />
            ))}
          </div>
        ) : buyers.length === 0 ? (
          <p className={styles.empty}>No buyers yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Buyer</th>
                  <th>Campaigns</th>
                  <th>Spend</th>
                  <th>Revenue</th>
                  <th>Profit</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {buyers.map((b) => (
                  <tr key={b.buyerId}>
                    <td>
                      <div className={styles.name}>{b.name}</div>
                      <div className={styles.subtle}>{b.email}</div>
                    </td>
                    <td className={styles.num}>{b.campaignCount}</td>
                    <td className={styles.num}>{formatUsd(b.spendUsd)}</td>
                    <td className={styles.num}>{formatUsd(b.revenueUsd)}</td>
                    <td className={`${styles.num} ${b.profitUsd > 0 ? styles.pos : b.profitUsd < 0 ? styles.neg : ''}`}>
                      {formatUsd(b.profitUsd)}
                    </td>
                    <td className={styles.num}>{formatUsd(b.marginUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Members */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Members</span>
        </div>
        {!members ? (
          <div className={styles.rowsSkel}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className={styles.rowSkel} />
            ))}
          </div>
        ) : members.length === 0 ? (
          <p className={styles.empty}>No members.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Member</th>
                  <th className={styles.thLeft}>Role</th>
                  <th className={styles.thLeft}>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className={styles.name}>{m.name}</div>
                      <div className={styles.subtle}>{m.email}</div>
                    </td>
                    <td className={styles.subtle}>{ROLE_LABEL[m.role] ?? m.role}</td>
                    <td>
                      <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>{m.status.toLowerCase()}</Badge>
                    </td>
                    <td>
                      <div className={styles.actions}>
                        {m.id !== user?.id &&
                          actionsFor(m.status).map((a) => (
                            <button
                              key={a.action}
                              type="button"
                              className={`${styles.actionBtn} ${a.danger ? styles.actionDanger : ''}`}
                              disabled={busy === m.id}
                              onClick={() => void act(m.id, a.action)}
                            >
                              {a.label}
                            </button>
                          ))}
                        {user?.role === 'SUPER_ADMIN' && m.id !== user?.id && m.role !== 'SUPER_ADMIN' && (
                          <button
                            type="button"
                            className={`${styles.actionBtn} ${styles.actionDanger}`}
                            disabled={busy === m.id}
                            onClick={() => void remove(m)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
