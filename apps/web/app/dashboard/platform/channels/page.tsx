'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type ChannelSummary, type ChannelUsage } from '@knn/shared';
import { Badge, Banner, Button, Card, Skeleton, useConfirm } from '@/components/ui';
import { ApiError, admin, adsense, domains } from '@/lib/api';
import { type AfsChannelRow, type DomainRow } from '@/lib/types';
import styles from '../../admin.module.css';

/**
 * Channels — the single home for AdSense channels: (1) pool summary counts,
 * (2) per-website catalog/import, (3) "where is this channel used" lineage. The hub
 * layout (platform/layout.tsx) guards super-admin.
 */
// Cap how many catalog rows we paint at once. The API can return up to ~2,000 matches
// (and accounts hold 100k+ channels); rendering them all jank the page, so we show a
// window and tell the user to narrow the range to reach the rest.
const ROW_CAP = 200;

export default function ChannelsPage() {
  const confirm = useConfirm();
  const [summary, setSummary] = useState<ChannelSummary | null>(null);
  const [domainList, setDomainList] = useState<DomainRow[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const loadSummary = useCallback(() => {
    void admin.channelSummary().then(setSummary).catch(() => setSummary(null));
  }, []);
  useEffect(() => loadSummary(), [loadSummary]);
  useEffect(() => {
    void domains.list().then((r) => setDomainList(r.domains)).catch(() => setDomainList([]));
  }, []);

  // ── Catalog / import (per website) — lifted from the old Domains page ──
  const [chDomainId, setChDomainId] = useState('');
  const [chQuery, setChQuery] = useState('');
  const [chRange, setChRange] = useState('');
  const [chRows, setChRows] = useState<AfsChannelRow[] | null>(null);
  const [chMeta, setChMeta] = useState<{ scanned: number; total: number; truncated: boolean } | null>(null);
  const [chSel, setChSel] = useState<Set<string>>(new Set());
  const [chBusy, setChBusy] = useState(false);
  const chDomain = domainList.find((d) => d.id === chDomainId) ?? null;

  // Preselect a domain from ?domain=<id> (the Domains table "Channels" button links here).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const d = new URLSearchParams(window.location.search).get('domain');
    if (d) setChDomainId(d);
  }, []);

  const loadChannels = useCallback(async (id: string, q: string, range: string): Promise<void> => {
    if (!id) return;
    setChBusy(true);
    setNote(null);
    try {
      const r = await domains.afsChannels(id, q, range);
      setChRows(r.channels);
      setChMeta({ scanned: r.scanned, total: r.total, truncated: r.truncated });
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Could not load channels');
      setChRows([]);
    } finally {
      setChBusy(false);
    }
  }, []);

  // Load the catalog whenever the selected domain changes.
  useEffect(() => {
    setChRows(null);
    setChSel(new Set());
    if (chDomainId) void loadChannels(chDomainId, '', '');
  }, [chDomainId, loadChannels]);

  const toggleSel = (cid: string): void =>
    setChSel((s) => {
      const n = new Set(s);
      if (n.has(cid)) n.delete(cid);
      else n.add(cid);
      return n;
    });
  const toggleSelAll = (): void =>
    setChSel((s) => {
      // Only the rows actually shown (capped) can be select-all'd.
      const ids = (chRows ?? []).slice(0, ROW_CAP).map((c) => c.channelId);
      const all = ids.length > 0 && ids.every((id) => s.has(id));
      return all ? new Set() : new Set(ids);
    });

  const syncCatalog = async (): Promise<void> => {
    if (!chDomain) return;
    setChBusy(true);
    setNote('Syncing channels from AdSense… (this can take a moment for large accounts)');
    try {
      const r = await adsense.syncCatalog(chDomain.afsAccountId);
      setNote(`Synced ${r.synced.toLocaleString()} channels from AdSense — browsing is now instant.`);
      await loadChannels(chDomain.id, chQuery, chRange);
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Could not sync the channel catalog');
    } finally {
      setChBusy(false);
    }
  };

  const importAll = async (): Promise<void> => {
    if (!chDomain) return;
    setChBusy(true);
    setNote(null);
    try {
      const r = await domains.importAllChannels(chDomain.id, chQuery, chRange);
      const desc = chRange.trim() ? ` in range ${chRange.trim()}` : chQuery ? ` matching “${chQuery}”` : '';
      setNote(
        `Imported ${r.added} channel${r.added === 1 ? '' : 's'} from the API${desc}` +
          (r.cappedAt ? ` (capped at ${r.cappedAt} of ${r.matched} — split into smaller ranges)` : '') + '.',
      );
      setChSel(new Set());
      await loadChannels(chDomain.id, chQuery, chRange);
      loadSummary();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Could not import channels');
    } finally {
      setChBusy(false);
    }
  };

  const removeSelected = async (): Promise<void> => {
    if (!chDomain || chSel.size === 0) return;
    const ok = await confirm({
      title: `Remove ${chSel.size} channel${chSel.size === 1 ? '' : 's'}?`,
      body: `These channels stop being usable on ${chDomain.host}. Channels currently assigned to a campaign are skipped.`,
      confirmLabel: 'Remove selected',
      tone: 'danger',
    });
    if (!ok) return;
    await applyChannels('remove');
  };

  const applyChannels = async (mode: 'add' | 'remove'): Promise<void> => {
    if (!chDomain || chSel.size === 0) return;
    setChBusy(true);
    setNote(null);
    try {
      const byId = new Map((chRows ?? []).map((c) => [c.channelId, c]));
      if (mode === 'add') {
        const add = [...chSel].filter((id) => !byId.get(id)?.imported).map((id) => ({ channelId: id, label: byId.get(id)?.displayName ?? undefined }));
        await domains.setChannels(chDomain.id, { add });
      } else {
        const remove = [...chSel].filter((id) => byId.get(id)?.imported && byId.get(id)?.status !== 'ASSIGNED');
        await domains.setChannels(chDomain.id, { remove });
      }
      setChSel(new Set());
      await loadChannels(chDomain.id, chQuery, chRange);
      loadSummary();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Could not update channels');
    } finally {
      setChBusy(false);
    }
  };

  // ── Usage lineage: where is this channel id used? ──
  const [usageQ, setUsageQ] = useState('');
  const [usage, setUsage] = useState<ChannelUsage | null | 'none'>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const lookup = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!usageQ.trim()) return;
    setUsageBusy(true);
    setUsage(null);
    try {
      setUsage(await admin.channelUsage(usageQ.trim()));
    } catch (err) {
      setUsage(err instanceof ApiError && err.status === 404 ? 'none' : null);
      if (!(err instanceof ApiError && err.status === 404)) setNote(err instanceof ApiError ? err.message : 'Lookup failed');
    } finally {
      setUsageBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className={`serif ${styles.title}`}>Channels</h1>
          <p className={styles.sub}>The AdSense channel pool — summary, per-website import, and where each channel id is used.</p>
        </div>
      </div>

      {note && (
        <Banner tone="info" onDismiss={() => setNote(null)}>
          {note}
        </Banner>
      )}

      {/* 1. Channel usage lineage */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Channel usage</span>
        </div>
        <form className={styles.domainForm} onSubmit={(e) => void lookup(e)}>
          <input className={styles.rangeInput} aria-label="Channel id to look up" placeholder="Search by channel id (the ch value)…" value={usageQ} onChange={(e) => setUsageQ(e.target.value)} />
          <Button type="submit" loading={usageBusy} disabled={!usageQ.trim()}>Look up</Button>
        </form>
        {usage === 'none' ? (
          <p className={styles.empty}>No channel found for that id.</p>
        ) : usage && usage !== null ? (
          <>
            <p className={styles.fieldHint}>
              <span className="mono">{usage.channelId}</span> · status {usage.status.toLowerCase()}
              {usage.host ? ` · pool: ${usage.host}` : ''} · gross platform revenue.
            </p>
            {usage.spans.length === 0 ? (
              <p className={styles.empty}>This channel has never been assigned to a campaign.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.thLeft}>Campaign</th>
                      <th className={styles.thLeft}>Company</th>
                      <th className={styles.thLeft}>Article</th>
                      <th className={styles.thLeft}>Website</th>
                      <th className={styles.thLeft}>Period</th>
                      <th>Revenue</th>
                      <th>AFS clicks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.spans.map((s, i) => (
                      <tr key={`${s.campaignId}-${s.firstDay}-${i}`}>
                        <td className={styles.name}>{s.campaignName ?? '—'}</td>
                        <td className={styles.subtle}>{s.companyName ?? '—'}</td>
                        <td className={styles.subtle}>
                          {s.liveUrl ? <a href={s.liveUrl} target="_blank" rel="noreferrer">{s.articleTitle ?? s.articleSlug ?? 'article'}</a> : s.articleTitle ?? '—'}
                        </td>
                        <td className={styles.subtle}>{s.host ?? '—'}</td>
                        <td className={styles.subtle}>
                          {s.firstDay}{s.firstDay !== s.lastDay ? ` → ${s.lastDay}` : ''}{' '}
                          {s.active && <Badge tone="success">now</Badge>}
                        </td>
                        <td className={styles.num}>${s.revenueUsd.toFixed(2)}</td>
                        <td className={styles.num}>{s.afsClicks.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </Card>

      {/* 2. Pool summary */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Pool summary</span>
          {summary && (
            <span className={styles.subtle}>
              {summary.available.toLocaleString()} available · {summary.assigned.toLocaleString()} in use · {summary.total.toLocaleString()} total
            </span>
          )}
        </div>
        {!summary ? (
          <Skeleton className={styles.rowSkel} />
        ) : summary.total === 0 ? (
          <p className={styles.empty}>No channels imported yet. Sync an AdSense account, then import channels per website below.</p>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th className={styles.thLeft}>Website</th><th>Channels</th><th>Available</th><th>In use</th></tr>
                </thead>
                <tbody>
                  {summary.byDomain.length === 0 ? (
                    <tr><td className={styles.subtle} colSpan={4}>No channels are tied to a website yet.</td></tr>
                  ) : (
                    summary.byDomain.map((d) => (
                      <tr key={d.domainId}>
                        <td className={styles.name}>{d.host}</td>
                        <td className={styles.num}>{d.total.toLocaleString()}</td>
                        <td className={styles.num}>{d.available.toLocaleString()}</td>
                        <td className={styles.num}>{(d.total - d.available).toLocaleString()}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {summary.untagged > 0 && (
              <p className={styles.fieldHint}>{summary.untagged.toLocaleString()} channel(s) are untagged (legacy/placeholder) — ignored by the offer funnel.</p>
            )}
          </>
        )}
      </Card>

      {/* 3. Catalog / import (per website) */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Import channels</span>
          <select className={styles.select} value={chDomainId} onChange={(e) => setChDomainId(e.target.value)} aria-label="Website">
            <option value="">Pick a website…</option>
            {domainList.map((d) => (<option key={d.id} value={d.id}>{d.host}</option>))}
          </select>
        </div>
        {!chDomain ? (
          <p className={styles.empty}>Pick a website to browse + import its AdSense channels.</p>
        ) : (
          <>
            <p className={styles.fieldHint}>
              Pick which channels <strong>{chDomain.host}</strong> uses — the name is a label; the channel id is what monetizes.
              Enter an <strong>id range</strong> (e.g. <span className="mono">00500-01499</span>) → Preview → Import range, or search by name.
              {chMeta && (<> Scanned {chMeta.scanned.toLocaleString()}{chMeta.truncated ? '+' : ''} · <strong>{chMeta.total.toLocaleString()} match</strong>{chMeta.truncated ? ' (first 2,000 — narrow the range)' : ''}.</>)}
            </p>
            <form className={styles.domainForm} onSubmit={(e) => { e.preventDefault(); void loadChannels(chDomain.id, chQuery, chRange); }}>
              <input className={styles.rangeInput} aria-label="Channel id range" placeholder="id range, e.g. 00500-01499" value={chRange} onChange={(e) => setChRange(e.target.value)} />
              <input className={styles.rangeInput} aria-label="Search channels by name or id" placeholder="or search by name / id…" value={chQuery} onChange={(e) => setChQuery(e.target.value)} />
              <Button type="submit" variant="ghost" loading={chBusy}>Preview</Button>
              <Button type="button" variant="ghost" onClick={() => void syncCatalog()} disabled={chBusy} title="Pull the account's full channel list from AdSense for instant browsing">Sync from AdSense</Button>
              <Button type="button" onClick={() => void importAll()} disabled={chBusy || (!chRange.trim() && !chQuery.trim())}>{chRange.trim() ? 'Import range' : 'Import all matching'}</Button>
              <Button type="button" onClick={() => void applyChannels('add')} disabled={chSel.size === 0}>Import selected ({chSel.size})</Button>
              <button type="button" className={`${styles.actionBtn} ${styles.actionDanger}`} disabled={chSel.size === 0} onClick={() => void removeSelected()}>Remove selected</button>
            </form>
            {!chRows ? (
              <div className={styles.rowsSkel}>{Array.from({ length: 4 }).map((_, i) => (<Skeleton key={i} className={styles.rowSkel} />))}</div>
            ) : chRows.length === 0 ? (
              <p className={styles.empty}>No channels found{chQuery ? ` for “${chQuery}”` : ''}.</p>
            ) : (
              (() => {
                const visible = chRows.slice(0, ROW_CAP);
                return (
                  <>
                    {chRows.length > ROW_CAP && (
                      <Banner tone="info">
                        Showing {visible.length.toLocaleString()} of {chRows.length.toLocaleString()} matched channels — narrow the id range or refine the search to see more.
                      </Banner>
                    )}
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th className={styles.thLeft}><input type="checkbox" aria-label="Select all shown channels" title="Select all shown" checked={visible.length > 0 && visible.every((c) => chSel.has(c.channelId))} onChange={toggleSelAll} /></th>
                            <th className={styles.thLeft}>Channel name</th>
                            <th className={styles.thLeft}>Channel ID</th>
                            <th className={styles.thLeft}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visible.map((c) => (
                            <tr key={c.channelId}>
                              <td><input type="checkbox" aria-label={`Select channel ${c.channelId}`} checked={chSel.has(c.channelId)} onChange={() => toggleSel(c.channelId)} /></td>
                              <td className={styles.name}>{c.displayName ?? <span className={styles.subtle}>(unnamed)</span>}</td>
                              <td className="mono">{c.channelId}</td>
                              <td>{c.imported ? <Badge tone={c.status === 'ASSIGNED' ? 'brand' : 'success'}>{(c.status ?? 'imported').toLowerCase()}</Badge> : <span className={styles.subtle}>—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                );
              })()
            )}
          </>
        )}
      </Card>
    </div>
  );
}
