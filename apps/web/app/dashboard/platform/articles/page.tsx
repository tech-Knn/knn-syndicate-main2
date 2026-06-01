'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { type ArticleRow, type ArticleUsage } from '@knn/shared';
import { Badge, Card, Skeleton } from '@/components/ui';
import { ApiError, admin } from '@/lib/api';
import styles from '../../admin.module.css';

/**
 * Articles — every generated article + its lineage: which campaigns use it, on which
 * domains/channels it's live, for what time, and gross revenue. Super-admin/company-admin
 * (the latter sees only its own org via RLS). Guarded by platform/layout.tsx.
 */
export default function ArticlesPage() {
  const [rows, setRows] = useState<ArticleRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Record<string, ArticleUsage | 'loading' | 'error'>>({});

  useEffect(() => {
    void admin.articles().then(setRows).catch(() => setRows([]));
  }, []);

  // Debounce the client filter so typing over the full set stays smooth.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    const out = (rows ?? []).filter((r) => !q || r.title.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q));
    return out;
  }, [rows, debounced]);

  const toggle = useCallback(
    (id: string): void => {
      if (openId === id) {
        setOpenId(null);
        return;
      }
      setOpenId(id);
      if (!usage[id]) {
        setUsage((u) => ({ ...u, [id]: 'loading' }));
        void admin
          .articleUsage(id)
          .then((u) => setUsage((prev) => ({ ...prev, [id]: u })))
          .catch((err) => setUsage((prev) => ({ ...prev, [id]: err instanceof ApiError ? 'error' : 'error' })));
      }
    },
    [openId, usage],
  );

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className={`serif ${styles.title}`}>Articles</h1>
          <p className={styles.sub}>Every generated article and where it&apos;s live — which campaigns, domains, channels, and for what time.</p>
        </div>
      </div>

      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>
            Articles{rows ? ` (${filtered.length.toLocaleString()}${debounced.trim() ? ` of ${rows.length.toLocaleString()}` : ''})` : ''}
          </span>
          <input
            className={styles.rangeInput}
            type="search"
            aria-label="Search articles by title or slug"
            placeholder="Search title or slug…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ minWidth: '14rem' }}
          />
        </div>
        {!rows ? (
          <div className={styles.rowsSkel}>{Array.from({ length: 4 }).map((_, i) => (<Skeleton key={i} className={styles.rowSkel} />))}</div>
        ) : filtered.length === 0 ? (
          <p className={styles.empty}>{rows.length === 0 ? 'No articles generated yet.' : 'No articles match your search.'}</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Title</th>
                  <th className={styles.thLeft}>Slug</th>
                  <th className={styles.thLeft}>Status</th>
                  <th className={styles.thLeft}>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const u = usage[a.id];
                  const open = openId === a.id;
                  return (
                    <Fragment key={a.id}>
                      <tr>
                        <td className={styles.name}>{a.title}</td>
                        <td className="mono">{a.slug}</td>
                        <td><Badge tone={a.status === 'READY' ? 'success' : 'neutral'}>{a.status.toLowerCase()}</Badge></td>
                        <td className={styles.subtle}>{new Date(a.createdAt).toLocaleDateString()}</td>
                        <td>
                          <button
                            type="button"
                            className={styles.actionBtn}
                            aria-expanded={open}
                            aria-label={open ? `Hide lineage for ${a.title}` : `Show lineage for ${a.title}`}
                            onClick={() => toggle(a.id)}
                          >
                            {open ? '▲ Hide' : '▼ Lineage'}
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5} style={{ background: 'var(--surface-2, rgba(255,255,255,0.02))' }}>
                            {u === 'loading' || u === undefined ? (
                              <Skeleton className={styles.rowSkel} />
                            ) : u === 'error' ? (
                              <p className={styles.empty}>Could not load lineage.</p>
                            ) : u.campaigns.length === 0 ? (
                              <p className={styles.empty}>Not used by any campaign yet.</p>
                            ) : (
                              <div style={{ padding: '0.4rem 0' }}>
                                <p className={styles.fieldHint}>
                                  Live on: {u.liveHosts.length ? u.liveHosts.map((h) => <span key={h} className="mono" style={{ marginRight: '0.5rem' }}>{h}</span>) : '—'}
                                  {' · '}gross revenue <strong>${u.totalRevenueUsd.toFixed(2)}</strong>
                                </p>
                                <div className={styles.tableWrap}>
                                  <table className={styles.table}>
                                    <thead>
                                      <tr>
                                        <th className={styles.thLeft}>Campaign</th>
                                        <th className={styles.thLeft}>Company</th>
                                        <th className={styles.thLeft}>Channel</th>
                                        <th className={styles.thLeft}>Website</th>
                                        <th className={styles.thLeft}>Period</th>
                                        <th>Revenue</th>
                                        <th>RPC</th>
                                        <th>Fill rate</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {u.campaigns.flatMap((c) =>
                                        (c.channels.length ? c.channels : [null]).map((ch, i) => (
                                          <tr key={`${c.campaignId}-${ch?.channelDbId ?? 'none'}-${i}`}>
                                            <td className={styles.name}>{i === 0 ? c.campaignName : ''}</td>
                                            <td className={styles.subtle}>{i === 0 ? c.companyName ?? '—' : ''}</td>
                                            <td className="mono">{ch?.channelId ?? '—'}</td>
                                            <td className={styles.subtle}>
                                              {ch?.liveUrl ? <a href={ch.liveUrl} target="_blank" rel="noreferrer">{ch.host}</a> : ch?.host ?? '—'}
                                            </td>
                                            <td className={styles.subtle}>
                                              {ch?.firstDay ? `${ch.firstDay}${ch.firstDay !== ch.lastDay ? ` → ${ch.lastDay}` : ''}` : '—'}{' '}
                                              {ch?.active && <Badge tone="success">now</Badge>}
                                            </td>
                                            <td className={styles.num}>{ch ? `$${ch.revenueUsd.toFixed(2)}` : '—'}</td>
                                            <td className={styles.num}>{ch && ch.rpc !== null ? `$${ch.rpc.toFixed(2)}` : '—'}</td>
                                            <td className={styles.num}>{ch && ch.fillRate !== null ? `${Math.round(ch.fillRate * 100)}%` : '—'}</td>
                                          </tr>
                                        )),
                                      )}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
