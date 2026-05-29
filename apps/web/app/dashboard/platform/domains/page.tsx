'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { admin, adsense, domains } from '@/lib/api';
import { type AfsAccountRow, type DomainRow, type OrgRow } from '@/lib/types';
import { useAuth } from '../../../providers';
import styles from '../../admin.module.css';

const STATUS_TONE: Record<string, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = {
  LIVE: 'success',
  VERIFYING: 'brand',
  PENDING_DNS: 'warning',
  ERROR: 'danger',
};

export default function DomainsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<DomainRow[] | null>(null);
  const [dns, setDns] = useState<{ cnameTarget: string } | null>(null);
  const [accounts, setAccounts] = useState<AfsAccountRow[]>([]);
  const [companies, setCompanies] = useState<OrgRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState({ host: '', afsAccountId: '', channelRanges: '', styleId: '' });
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (user && user.role !== 'SUPER_ADMIN') router.replace('/dashboard');
  }, [user, router]);

  const load = useCallback(() => {
    void domains
      .list()
      .then((r) => {
        setRows(r.domains);
        setDns(r.dns);
      })
      .catch(() => setRows([]));
    // AFS accounts feed the "map domain → AFS account" dropdown (channel browsing lives in Channels now).
    void adsense.accounts().then(setAccounts).catch(() => setAccounts([]));
    void admin.organizations().then(setCompanies).catch(() => setCompanies([]));
  }, []);
  useEffect(() => load(), [load]);

  const setOwner = async (id: string, orgId: string): Promise<void> => {
    setBusy(id + 'Owner');
    setNote(null);
    try {
      await domains.setOwner(id, orgId || null);
      load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not update owner');
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form.host.trim() || !form.afsAccountId) return;
    setAdding(true);
    setNote(null);
    try {
      await domains.create({
        host: form.host.trim(),
        afsAccountId: form.afsAccountId,
        channelRanges: form.channelRanges.trim() || undefined,
        styleId: form.styleId.trim() || undefined,
      });
      setForm({ host: '', afsAccountId: '', channelRanges: '', styleId: '' });
      load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not add domain');
    } finally {
      setAdding(false);
    }
  };

  const act = async (id: string, fn: () => Promise<unknown>, label: string): Promise<void> => {
    setBusy(id + label);
    setNote(null);
    try {
      await fn();
      load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Domains</span>
          <h1 className={`serif ${styles.title}`}>Websites &amp; AFS</h1>
          <p className={styles.sub}>Register article domains, map each to an AFS account, and verify DNS. Import &amp; browse a domain&apos;s channels from the Channels page.</p>
        </div>
      </div>

      {note && <Card className={styles.errorCard}>{note}</Card>}

      {/* Add domain */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Add a domain</span>
          {dns && (
            <span className={styles.subtle}>
              DNS: point a CNAME to <strong className="mono">{dns.cnameTarget}</strong> (then Verify)
            </span>
          )}
        </div>
        <form className={styles.domainForm} onSubmit={(e) => void add(e)}>
          <input
            className={styles.rangeInput}
            placeholder="articles.yourdomain.com"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
          />
          <select
            className={styles.select}
            value={form.afsAccountId}
            onChange={(e) => setForm({ ...form, afsAccountId: e.target.value })}
          >
            <option value="">AFS account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label ?? a.afsPubId ?? a.account}
              </option>
            ))}
          </select>
          <input
            className={styles.rangeInput}
            placeholder="channel ranges (09000-09500)"
            value={form.channelRanges}
            onChange={(e) => setForm({ ...form, channelRanges: e.target.value })}
          />
          <input
            className={styles.rangeInput}
            placeholder="style id (optional)"
            value={form.styleId}
            onChange={(e) => setForm({ ...form, styleId: e.target.value })}
          />
          <Button type="submit" loading={adding} disabled={!form.host.trim() || !form.afsAccountId}>
            Add domain
          </Button>
        </form>
        {accounts.length === 0 && <p className={styles.fieldHint}>Connect an AFS account on the Setup page first.</p>}
      </Card>

      {/* Domains list */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Registered domains</span>
        </div>
        {!rows ? (
          <div className={styles.rowsSkel}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className={styles.rowSkel} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className={styles.empty}>No domains yet. Add one above.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Domain</th>
                  <th className={styles.thLeft}>AFS account</th>
                  <th className={styles.thLeft}>Owner</th>
                  <th className={styles.thLeft}>Ranges</th>
                  <th>Channels</th>
                  <th className={styles.thLeft}>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className={styles.name}>{d.host}</div>
                      {d.lastCheck && <div className={styles.subtle}>{d.lastCheck.slice(0, 60)}</div>}
                    </td>
                    <td className={styles.subtle}>
                      {d.afsLabel ?? '—'}
                      {d.afsPubId && <div className="mono">{d.afsPubId}</div>}
                    </td>
                    <td>
                      <select
                        className={styles.select}
                        value={d.ownerOrgId ?? ''}
                        disabled={busy === d.id + 'Owner'}
                        onChange={(e) => void setOwner(d.id, e.target.value)}
                        aria-label={`Owner for ${d.host}`}
                      >
                        <option value="">Shared (all companies)</option>
                        {companies.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={styles.subtle}>{d.channelRanges ?? '—'}</td>
                    <td className={styles.num}>{d.channelCount}</td>
                    <td>
                      <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{d.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <button type="button" className={styles.actionBtn} disabled={busy === d.id + 'Verify'} onClick={() => void act(d.id, () => domains.verify(d.id), 'Verify')}>
                          Verify
                        </button>
                        <button type="button" className={styles.actionBtn} disabled={busy === d.id + 'Sync' || !d.channelRanges} onClick={() => void act(d.id, () => domains.sync(d.id), 'Sync')}>
                          Sync
                        </button>
                        <button type="button" className={styles.actionBtn} onClick={() => router.push(`/dashboard/platform/channels?domain=${d.id}`)} title="Browse & import this website's channels">
                          Channels
                        </button>
                        <button type="button" className={`${styles.actionBtn} ${styles.actionDanger}`} disabled={busy === d.id + 'Remove'} onClick={() => void act(d.id, () => domains.remove(d.id), 'Remove')}>
                          Remove
                        </button>
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
