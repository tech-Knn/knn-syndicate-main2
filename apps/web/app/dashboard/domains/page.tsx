'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { adsense, domains } from '@/lib/api';
import { type AfsAccountRow, type AfsChannelRow, type DomainRow } from '@/lib/types';
import { useAuth } from '../../providers';
import styles from '../admin.module.css';

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
    void adsense.accounts().then(setAccounts).catch(() => setAccounts([]));
  }, []);
  useEffect(() => load(), [load]);

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

  // ── Channel browser: pick AFS channels by name, import/remove them for a domain ──
  const [chDomain, setChDomain] = useState<DomainRow | null>(null);
  const [chQuery, setChQuery] = useState('');
  const [chRows, setChRows] = useState<AfsChannelRow[] | null>(null);
  const [chMeta, setChMeta] = useState<{ scanned: number; total: number; truncated: boolean } | null>(null);
  const [chSel, setChSel] = useState<Set<string>>(new Set());
  const [chBusy, setChBusy] = useState(false);

  const loadChannels = useCallback(async (id: string, q: string): Promise<void> => {
    setChBusy(true);
    setNote(null);
    try {
      const r = await domains.afsChannels(id, q);
      setChRows(r.channels);
      setChMeta({ scanned: r.scanned, total: r.total, truncated: r.truncated });
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not load channels');
      setChRows([]);
    } finally {
      setChBusy(false);
    }
  }, []);

  const openChannels = (d: DomainRow): void => {
    setChDomain(d);
    setChRows(null);
    setChSel(new Set());
    setChQuery('');
    void loadChannels(d.id, '');
  };

  const toggleSel = (cid: string): void =>
    setChSel((s) => {
      const n = new Set(s);
      if (n.has(cid)) n.delete(cid);
      else n.add(cid);
      return n;
    });

  const applyChannels = async (mode: 'add' | 'remove'): Promise<void> => {
    if (!chDomain || chSel.size === 0) return;
    setChBusy(true);
    setNote(null);
    try {
      const byId = new Map((chRows ?? []).map((c) => [c.channelId, c]));
      if (mode === 'add') {
        const add = [...chSel]
          .filter((id) => !byId.get(id)?.imported)
          .map((id) => ({ channelId: id, label: byId.get(id)?.displayName ?? undefined }));
        await domains.setChannels(chDomain.id, { add });
      } else {
        const remove = [...chSel].filter((id) => byId.get(id)?.imported && byId.get(id)?.status !== 'ASSIGNED');
        await domains.setChannels(chDomain.id, { remove });
      }
      setChSel(new Set());
      await loadChannels(chDomain.id, chQuery);
      load(); // refresh the domain's channel count
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not update channels');
    } finally {
      setChBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Domains</span>
          <h1 className={`serif ${styles.title}`}>Websites &amp; AFS</h1>
          <p className={styles.sub}>Register article domains, map each to an AFS account, verify DNS, and import its channels.</p>
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
        {accounts.length === 0 && <p className={styles.fieldHint}>Connect an AFS account on the Platform page first.</p>}
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
                        <button type="button" className={styles.actionBtn} onClick={() => openChannels(d)}>
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

      {/* Channel browser — pick AFS channels by name for the selected domain. */}
      {chDomain && (
        <Card className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Channels — {chDomain.host}</span>
            <button type="button" className={styles.actionBtn} onClick={() => setChDomain(null)}>
              Close
            </button>
          </div>
          <p className={styles.fieldHint}>
            Browse this website&apos;s AFS account channels by name and pick which to use — the name is just a label,
            the channel id is what monetizes.{' '}
            {chMeta && (
              <>
                Scanned {chMeta.scanned}
                {chMeta.truncated ? '+ (refine with search)' : ''}, {chMeta.total} match.
              </>
            )}
          </p>
          <form
            className={styles.domainForm}
            onSubmit={(e) => {
              e.preventDefault();
              void loadChannels(chDomain.id, chQuery);
            }}
          >
            <input
              className={styles.rangeInput}
              placeholder="search by channel name or id…"
              value={chQuery}
              onChange={(e) => setChQuery(e.target.value)}
            />
            <Button type="submit" variant="ghost" loading={chBusy}>
              Search
            </Button>
            <Button type="button" onClick={() => void applyChannels('add')} disabled={chSel.size === 0}>
              Import selected ({chSel.size})
            </Button>
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.actionDanger}`}
              disabled={chSel.size === 0}
              onClick={() => void applyChannels('remove')}
            >
              Remove selected
            </button>
          </form>

          {!chRows ? (
            <div className={styles.rowsSkel}>
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className={styles.rowSkel} />
              ))}
            </div>
          ) : chRows.length === 0 ? (
            <p className={styles.empty}>No channels found{chQuery ? ` for “${chQuery}”` : ''}.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.thLeft}></th>
                    <th className={styles.thLeft}>Channel name</th>
                    <th className={styles.thLeft}>Channel ID</th>
                    <th className={styles.thLeft}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {chRows.map((c) => (
                    <tr key={c.channelId}>
                      <td>
                        <input type="checkbox" checked={chSel.has(c.channelId)} onChange={() => toggleSel(c.channelId)} />
                      </td>
                      <td className={styles.name}>
                        {c.displayName ?? <span className={styles.subtle}>(unnamed)</span>}
                      </td>
                      <td className="mono">{c.channelId}</td>
                      <td>
                        {c.imported ? (
                          <Badge tone={c.status === 'ASSIGNED' ? 'brand' : 'success'}>{(c.status ?? 'imported').toLowerCase()}</Badge>
                        ) : (
                          <span className={styles.subtle}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
