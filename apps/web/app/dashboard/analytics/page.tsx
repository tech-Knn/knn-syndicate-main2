'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  type CampaignBreakdown,
  type CampaignPerf,
  addBusinessDays,
  currentBusinessDay,
  formatRate,
  formatRoi,
  formatUnitUsd,
  formatUsd,
} from '@knn/shared';
import {
  Badge,
  Banner,
  Button,
  type DateRange,
  DateRangePicker,
  EmptyState,
  InfoTip,
  type SearchOption,
  SearchSelect,
  Segmented,
  Skeleton,
  StatTile,
} from '@/components/ui';
import { IconExternal, IconPause, IconPlay } from '@/components/icons';
import { Tooltip } from '@/components/tooltip';
import { campaigns as campaignApi, facebook, stats } from '@/lib/api';
import { useAuth } from '../../providers';
import admin from '../admin.module.css';
import styles from '../analytics.module.css';
import { BudgetCell } from './budget-cell';
import { CampaignDetail } from './campaign-detail';
import { ColumnPicker } from './column-picker';
import {
  ALL_COLUMNS,
  COLUMNS,
  type CellCtx,
  type ColKey,
  ESSENTIAL_COLUMNS,
  GROUPS,
  type GroupKey,
  derive,
  fmtCount,
  sumInputs,
} from './columns';

function rangeFor(days: number): DateRange {
  const to = currentBusinessDay();
  return { from: addBusinessDays(to, -(days - 1)), to };
}

const STATUS_TONE: Record<string, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = {
  ACTIVE: 'success',
  PROCESSING: 'brand',
  LAUNCHING: 'brand',
  PENDING_APPROVAL: 'warning',
  BATCHED: 'warning',
  QUEUED_NO_CHANNEL: 'warning',
  PAUSED: 'neutral',
  DRAFT: 'neutral',
  REJECTED: 'danger',
  META_REJECTED: 'danger',
  ARCHIVED: 'neutral',
};
const statusLabel = (s: string): string => s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Relative "x ago" for the sync-freshness indicator (recomputed on each ~60s re-render). */
function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

/** Compact, always-on freshness indicator. Data lands on the worker crons — status ~30 min, spend
 *  hourly — and Meta/AdSense only refresh their own reporting every ~15–30 min. */
function SyncIndicator({ sync }: { sync: Awaited<ReturnType<typeof stats.syncStatus>> | null }): React.ReactNode {
  if (!sync) return null;
  return (
    <span
      className={styles.syncIndicator}
      title="Facebook status and spend/revenue update automatically on a schedule. There’s no manual refresh — Facebook and AdSense only refresh this data every ~15–30 minutes."
    >
      <span className={styles.syncDot} aria-hidden />
      Auto-updates · status {timeAgo(sync.fbStatus.at)} · spend {timeAgo(sync.metrics.at)}
    </span>
  );
}

type IdKey = 'name' | 'status';
type SortKey = IdKey | ColKey;

const PAGE_SIZE = 50;
const COLUMNS_STORAGE_KEY = 'knn.analytics.columns.v2';

function sortValue(r: CampaignPerf, key: SortKey): number | string | null {
  switch (key) {
    case 'name':
      return r.name.toLowerCase();
    case 'status':
      return r.status;
    default:
      return COLUMNS.find((c) => c.key === key)?.sort?.(r) ?? null;
  }
}

function loadColumns(): ColKey[] {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return ESSENTIAL_COLUMNS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ESSENTIAL_COLUMNS;
    const valid = parsed.filter((k): k is ColKey => ALL_COLUMNS.includes(k as ColKey));
    return valid.length ? valid : ESSENTIAL_COLUMNS;
  } catch {
    return ESSENTIAL_COLUMNS;
  }
}

export default function AnalyticsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'SUPER_ADMIN' || user?.role === 'COMPANY_ADMIN';
  const isSuper = user?.role === 'SUPER_ADMIN';

  const [range, setRange] = useState<DateRange>(() => rangeFor(1));
  const [rows, setRows] = useState<CampaignPerf[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set());
  const [buyerSel, setBuyerSel] = useState('');
  const [companySel, setCompanySel] = useState('');
  const [profitSel, setProfitSel] = useState<'all' | 'profit' | 'loss'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('spend');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [breakdowns, setBreakdowns] = useState<Record<string, CampaignBreakdown>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Sync freshness + connection health (no manual refresh — data lands on the worker crons).
  const [sync, setSync] = useState<Awaited<ReturnType<typeof stats.syncStatus>> | null>(null);
  const [brokenConns, setBrokenConns] = useState<{ id: string; name: string }[]>([]);

  // Visible metric columns (a preset or a custom pick), remembered per browser.
  const [columns, setColumns] = useState<ColKey[]>(ESSENTIAL_COLUMNS);
  useEffect(() => setColumns(loadColumns()), []);
  const chooseColumns = (next: ColKey[]): void => {
    setColumns(next);
    try {
      localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode etc. — the choice just won't persist */
    }
  };

  // The scroll container's visible width → the expanded detail panel pins to it, so it stays in
  // view (and scrolls on its own) however far the table itself is scrolled sideways.
  const resizeRef = useRef<ResizeObserver | null>(null);
  const gridRef = useCallback((el: HTMLDivElement | null) => {
    resizeRef.current?.disconnect();
    resizeRef.current = null;
    if (!el) return;
    const set = (): void => el.style.setProperty('--grid-w', `${el.clientWidth}px`);
    set();
    if (typeof ResizeObserver !== 'undefined') {
      resizeRef.current = new ResizeObserver(set);
      resizeRef.current.observe(el);
    }
  }, []);

  const load = useCallback(async (r: DateRange, silent = false) => {
    if (!silent) setRows(null);
    setError(null);
    try {
      setRows(await stats.campaigns(r));
    } catch {
      setError('Could not load campaigns. Retrying shortly…');
    }
  }, []);

  const loadSyncMeta = useCallback(async () => {
    try {
      const [s, profiles] = await Promise.all([stats.syncStatus(), facebook.profiles()]);
      setSync(s);
      // Only DATA/VERIFY connections feed status+spend sync; a broken LAUNCH token is expected.
      setBrokenConns(profiles.filter((p) => p.status === 'CONNECTION_BROKEN' && p.appKind !== 'LAUNCH').map((p) => ({ id: p.id, name: p.name })));
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    void load(range);
    void loadSyncMeta();
    setBreakdowns({});
    const id = setInterval(() => {
      void load(range, true);
      void loadSyncMeta();
    }, 60_000);
    return () => clearInterval(id);
  }, [range, load, loadSyncMeta]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => setPage(0), [debouncedSearch, statusSel, buyerSel, companySel, profitSel, range]);

  const statuses = useMemo(() => [...new Set((rows ?? []).map((r) => r.status))].sort(), [rows]);
  const buyerOptions = useMemo<SearchOption[]>(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) m.set(r.buyerId, r.buyerName);
    return [{ value: '', label: 'All buyers' }, ...[...m].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
  }, [rows]);
  const companyOptions = useMemo<SearchOption[]>(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) m.set(r.orgId, r.companyName);
    return [{ value: '', label: 'All companies' }, ...[...m].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
  }, [rows]);

  const filtered = useMemo(() => {
    let out = rows ?? [];
    const q = debouncedSearch.trim().toLowerCase();
    if (q) out = out.filter((r) => r.name.toLowerCase().includes(q) || (r.channelLabel ?? '').toLowerCase().includes(q) || r.buyerName.toLowerCase().includes(q));
    if (statusSel.size > 0) out = out.filter((r) => statusSel.has(r.status));
    if (buyerSel) out = out.filter((r) => r.buyerId === buyerSel);
    if (companySel) out = out.filter((r) => r.orgId === companySel);
    if (profitSel === 'profit') out = out.filter((r) => r.profitUsd > 0);
    if (profitSel === 'loss') out = out.filter((r) => r.profitUsd < 0);
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...out].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // "no value" always sorts last
      if (bv === null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (av - bv) * dir;
    });
  }, [rows, debouncedSearch, statusSel, buyerSel, companySel, profitSel, sortKey, sortDir]);

  const totals = useMemo(() => sumInputs(filtered), [filtered]);
  const cellCtx = useMemo<CellCtx>(
    () => ({ maxSpend: Math.max(0, ...filtered.map((r) => r.spendUsd)), maxRevenue: Math.max(0, ...filtered.map((r) => r.revenueUsd)) }),
    [filtered],
  );

  const visibleCols = useMemo(() => COLUMNS.filter((c) => columns.includes(c.key)), [columns]);
  const groupSpans = useMemo(() => {
    const spans: { group: GroupKey; count: number }[] = [];
    for (const c of visibleCols) {
      const last = spans[spans.length - 1];
      if (last && last.group === c.group) last.count += 1;
      else spans.push({ group: c.group, count: 1 });
    }
    return spans;
  }, [visibleCols]);

  // First column of each metric group gets a hairline divider so the table reads in clusters.
  const groupStarts = useMemo(() => new Set(groupSpans.reduce<{ at: number; keys: ColKey[] }>((acc, g) => ({ at: acc.at + g.count, keys: [...acc.keys, visibleCols[acc.at]!.key] }), { at: 0, keys: [] }).keys), [groupSpans, visibleCols]);
  const idCols = 2; // campaign (+ buyer · company · channel underneath), status
  const colSpan = idCols + visibleCols.length + 1; // + actions

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const sortBy = (key: SortKey): void => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'status' ? 'asc' : 'desc');
    }
  };

  const toggleStatus = (s: string): void =>
    setStatusSel((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const toggleExpand = async (id: string): Promise<void> => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!breakdowns[id]) {
      try {
        const bd = await stats.campaignBreakdown(id, range);
        setBreakdowns((p) => ({ ...p, [id]: bd }));
      } catch {
        /* non-critical */
      }
    }
  };

  const toggleActive = async (r: CampaignPerf, active: boolean): Promise<void> => {
    setBusy(r.id);
    try {
      const res = active ? await campaignApi.resume(r.id) : await campaignApi.pause(r.id);
      setRows((prev) => (prev ? prev.map((x) => (x.id === r.id ? { ...x, status: res.status } : x)) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the campaign');
    } finally {
      setBusy(null);
    }
  };

  // CSV always carries every metric, whatever the on-screen column pick.
  const exportCsv = (): void => {
    const metricCols = COLUMNS.filter((c) => c.key !== 'budget');
    const head = ['Campaign', 'Status', 'Buyer', 'Company', 'Channel', 'Daily budget', ...metricCols.map((c) => c.label)];
    const esc = (v: string | number): string => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      head.join(','),
      ...filtered.map((r) =>
        [
          r.name,
          r.status,
          r.buyerName,
          r.companyName,
          r.channelLabel ?? '',
          r.dailyBudgetCents != null ? (r.dailyBudgetCents / 100).toFixed(2) : '',
          ...metricCols.map((c) => c.csv(r)),
        ]
          .map(esc)
          .join(','),
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `knn-analytics-${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearAllFilters = (): void => {
    setSearch('');
    setDebouncedSearch('');
    setStatusSel(new Set());
    setBuyerSel('');
    setCompanySel('');
    setProfitSel('all');
  };
  const hasFilters = search !== '' || statusSel.size > 0 || buyerSel !== '' || companySel !== '' || profitSel !== 'all';

  const SortHead = ({ k, label, info, left, start, extraClass }: { k: SortKey; label: string; info?: string; left?: boolean; start?: boolean; extraClass?: string }): React.ReactNode => {
    const active = sortKey === k;
    return (
      <th
        scope="col"
        className={`${left ? admin.thLeft : styles.thNum} ${styles.sortable} ${start ? styles.groupStart : ''} ${extraClass ?? ''}`}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {info ? (
          // The label itself explains the metric (hover / keyboard focus) — no separate (i) per column.
          <Tooltip content={info} wrapsControl className={styles.headTip}>
            <button type="button" className={styles.sortBtn} onClick={() => sortBy(k)}>
              <span className={styles.defined}>{label}</span>
              <span className={styles.srOnly}>. {info}</span>
              <span className={styles.arrow} aria-hidden>
                {active ? (sortDir === 'asc' ? '▲' : '▼') : ''}
              </span>
            </button>
          </Tooltip>
        ) : (
          <button type="button" className={styles.sortBtn} onClick={() => sortBy(k)}>
            {label}
            <span className={styles.arrow} aria-hidden>
              {active ? (sortDir === 'asc' ? '▲' : '▼') : ''}
            </span>
          </button>
        )}
      </th>
    );
  };

  // Row click anywhere (not on a control) toggles the breakdown — a bigger target than the caret.
  const onRowClick = (e: React.MouseEvent, id: string): void => {
    if ((e.target as HTMLElement).closest('button, a, input, label, select, textarea')) return;
    if (window.getSelection()?.toString()) return; // selecting text, not clicking
    void toggleExpand(id);
  };

  // Unit economics for the summary + the EPV-vs-CPC verdict.
  const tEpv = derive.epv(totals);
  const tCpc = derive.cpc(totals);
  const tRpc = derive.rpc(totals);
  const tVcvr = derive.vcvr(totals);
  const tProfit = derive.profit(totals);
  const tRoi = derive.roi(totals);

  return (
    <div className={admin.page}>
      <div className={admin.head}>
        <div>
          <span className="eyebrow">Analytics</span>
          <h1 className={`serif ${admin.title}`}>Performance</h1>
          <p className={admin.sub}>Every campaign with the numbers that decide profit — spend, earnings, and what each visit and click is worth.</p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {brokenConns.length > 0 && (
        <Banner tone="warning">
          {brokenConns.length === 1
            ? `Your Facebook connection “${brokenConns[0]!.name}” needs reconnecting — campaign status and spend have stopped updating for its campaigns.`
            : `${brokenConns.length} Facebook connections need reconnecting — campaign status and spend have stopped updating for their campaigns.`}{' '}
          <Link href="/dashboard/facebook" className={styles.bannerLink}>
            Reconnect →
          </Link>
        </Banner>
      )}

      {/* Toolbar: search + filters + view controls */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarRow}>
          <input className={styles.search} placeholder="Search campaign, channel, or buyer…" aria-label="Search campaigns" value={search} onChange={(e) => setSearch(e.target.value)} />
          {isAdmin && (
            <div className={styles.filterSelect}>
              <SearchSelect value={buyerSel} onChange={setBuyerSel} options={buyerOptions} placeholder="All buyers" />
            </div>
          )}
          {isSuper && (
            <div className={styles.filterSelect}>
              <SearchSelect value={companySel} onChange={setCompanySel} options={companyOptions} placeholder="All companies" />
            </div>
          )}
          <Segmented
            value={profitSel}
            onChange={setProfitSel}
            ariaLabel="Filter by profitability"
            options={[
              { value: 'all', label: 'All' },
              { value: 'profit', label: 'Profitable' },
              { value: 'loss', label: 'Losing' },
            ]}
          />
          {hasFilters && (
            <Button variant="ghost" onClick={clearAllFilters}>
              Reset all
            </Button>
          )}
          <div className={styles.spacer} />
          <SyncIndicator sync={sync} />
          <ColumnPicker value={columns} onChange={chooseColumns} />
          <button type="button" className={styles.toolBtn} onClick={exportCsv} disabled={filtered.length === 0}>
            Export CSV
          </button>
        </div>
        {statuses.length > 0 && (
          <div className={styles.chips}>
            {statuses.map((s) => (
              <button key={s} type="button" aria-pressed={statusSel.has(s)} className={`${styles.chip} ${statusSel.has(s) ? styles.chipActive : ''}`} onClick={() => toggleStatus(s)}>
                {statusLabel(s)}
              </button>
            ))}
            {statusSel.size > 0 && (
              <button type="button" className={styles.chip} onClick={() => setStatusSel(new Set())}>
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {!rows ? (
        <div className={admin.rowsSkel}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className={admin.rowSkel} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No campaigns match"
          description={hasFilters ? 'No campaigns match the current filters. Clear them or widen the date range.' : 'No campaign performance in this date range yet. Try a wider range.'}
          action={
            hasFilters ? (
              <Button variant="secondary" onClick={clearAllFilters}>
                Clear all filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* At-a-glance totals for the current filter: the result, then the unit economics behind it. */}
          <section className={styles.summary} aria-label="Totals for the campaigns shown">
            <div className={styles.summaryGroup}>
              <span className={styles.summaryLabel}>Results · {fmtCount(filtered.length)} {filtered.length === 1 ? 'campaign' : 'campaigns'}</span>
              <div className={styles.summaryStrip}>
                <StatTile label="Spend" value={formatUsd(totals.spendUsd)} sub={`${fmtCount(totals.clicks)} visits`} info="Facebook ad spend across the campaigns shown." />
                <StatTile label="Revenue" value={formatUsd(totals.revenueUsd)} sub={`${fmtCount(totals.adClicks)} ad clicks`} info="AdSense earnings attributed to the campaigns shown (after any platform cut). Lags spend by a few hours." />
                <StatTile
                  label="Profit"
                  value={formatUsd(tProfit)}
                  tone={tProfit > 0 ? 'pos' : tProfit < 0 ? 'neg' : 'neutral'}
                  sub={tProfit >= 0 ? 'In the green' : 'In the red'}
                  info="Revenue − spend."
                />
                <StatTile
                  label="ROI"
                  value={tRoi === null ? '—' : formatRoi(tRoi)}
                  tone={tRoi === null || tRoi === 0 ? 'neutral' : tRoi > 0 ? 'pos' : 'neg'}
                  sub="Profit ÷ spend"
                  info="Profit ÷ spend. Revenue can lag spend by a few hours, so a brand-new campaign looks worse than it is."
                />
              </div>
            </div>
            <div className={styles.summaryGroup}>
              <span className={styles.summaryLabel}>Per visit &amp; per click · same definitions as ClickFlare</span>
              <div className={styles.summaryStrip}>
                <StatTile
                  label="EPV"
                  value={formatUnitUsd(tEpv)}
                  tone={tEpv === null || tCpc === null ? 'neutral' : tEpv > tCpc ? 'pos' : tEpv < tCpc ? 'neg' : 'neutral'}
                  sub={tCpc === null ? 'earned per visit' : `vs ${formatUnitUsd(tCpc)} CPC`}
                  info="Earnings per visit = revenue ÷ visits (ClickFlare EPV). You make money when EPV beats CPC."
                />
                <StatTile label="CPC" value={formatUnitUsd(tCpc)} sub="paid per visit" info="Spend ÷ visits (Facebook link clicks). ClickFlare CPV." />
                <StatTile
                  label="RPC"
                  value={formatUnitUsd(tRpc)}
                  sub="per ad click"
                  info="Revenue ÷ ad clicks — ClickFlare's Dynamic payout. Ad clicks are counted live by our page, once per visit that clicked a Google ad."
                />
                <StatTile
                  label="vCVR"
                  value={formatRate(tVcvr)}
                  sub="visitors who clicked an ad"
                  info="Ad clicks ÷ visits (ClickFlare vCVR)."
                />
              </div>
            </div>
          </section>

          <div ref={gridRef} className={styles.grid} role="region" aria-label="Campaign performance" tabIndex={0}>
            <table className={`${admin.table} ${styles.gridTable}`}>
              <thead>
                <tr className={styles.groupRow}>
                  <th scope="colgroup" className={`${admin.thLeft} ${styles.groupHeadFirst}`} />
                  <th className={`${styles.groupHead} ${styles.statusCol}`} />
                  {groupSpans.map((g, i) => (
                    <th key={`${g.group}-${i}`} scope="colgroup" colSpan={g.count} className={`${styles.groupHead} ${styles.groupStart} ${styles[`group_${g.group}`] ?? ''}`}>
                      {GROUPS[g.group].label && (
                        <span className={styles.thInner}>
                          {GROUPS[g.group].label}
                          <InfoTip>{GROUPS[g.group].info}</InfoTip>
                        </span>
                      )}
                    </th>
                  ))}
                  <th className={styles.groupHead} />
                </tr>
                <tr>
                  <SortHead k="name" label="Campaign" left />
                  <SortHead k="status" label="Status" left extraClass={styles.statusCol} />
                  {visibleCols.map((c) =>
                    c.sort ? (
                      <SortHead key={c.key} k={c.key} label={c.label} info={c.info} start={groupStarts.has(c.key)} />
                    ) : (
                      <th key={c.key} scope="col" className={`${styles.thNum} ${groupStarts.has(c.key) ? styles.groupStart : ''}`}>
                        <Tooltip content={c.info} className={styles.headTip}>
                          <span className={`${styles.defined} ${styles.plainHead}`}>{c.label}</span>
                        </Tooltip>
                      </th>
                    ),
                  )}
                  <th scope="col" className={styles.thNum}>
                    <span className={styles.srOnly}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => {
                  const open = expanded === r.id;
                  const detailId = `analytics-detail-${r.id}`;
                  return (
                    <FragmentRow key={r.id}>
                      <tr className={`${styles.dataRow} ${open ? styles.rowOpen : ''}`} onClick={(e) => onRowClick(e, r.id)}>
                        <th scope="row" className={`${admin.thLeft} ${styles.nameCell}`}>
                          <button type="button" className={styles.discloseBtn} aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={() => void toggleExpand(r.id)}>
                            <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`} aria-hidden>
                              ▸
                            </span>
                            <span className={styles.discloseName}>
                              <span className={styles.campaignName}>{r.name}</span>
                              <span className={styles.cellSub}>
                                {/* Phones: the Status column is hidden, so the status rides here. */}
                                <span className={`${styles.mobileStatus} ${styles[`tone_${STATUS_TONE[r.status] ?? 'neutral'}`] ?? ''}`}>{statusLabel(r.status)} · </span>
                                {[isAdmin ? r.buyerName : null, isSuper ? r.companyName : null, r.channelLabel ? `ch ${r.channelLabel.replace(/^ch\s*/i, '')}` : null].filter(Boolean).join(' · ') || ' '}
                              </span>
                            </span>
                          </button>
                        </th>
                        <td className={`${styles.statusCell} ${styles.statusCol}`}>
                          <Badge tone={STATUS_TONE[r.status] ?? 'neutral'} dot>
                            {statusLabel(r.status)}
                          </Badge>
                        </td>
                        {visibleCols.map((c) =>
                          c.key === 'budget' ? (
                            <td key={c.key} className={`${admin.num} ${groupStarts.has(c.key) ? styles.groupStart : ''}`}>
                              <BudgetCell
                                cents={r.dailyBudgetCents}
                                editable={(r.status === 'ACTIVE' || r.status === 'PAUSED') && (r.budgetMode === 'CAMPAIGN' || r.adSetCount === 1)}
                                emptyLabel={r.budgetMode === 'AD_SET' && r.adSetCount > 1 ? 'Per ad set' : undefined}
                                label={r.name}
                                save={(cents) => campaignApi.setBudget(r.id, cents)}
                                onSaved={(cents) => setRows((prev) => (prev ? prev.map((x) => (x.id === r.id ? { ...x, dailyBudgetCents: cents } : x)) : prev))}
                                onError={setError}
                              />
                            </td>
                          ) : (
                            <td key={c.key} className={`${admin.num} ${styles.barTd} ${groupStarts.has(c.key) ? styles.groupStart : ''} ${c.tone?.(r) ?? ''}`}>
                              {c.cell(r, cellCtx)}
                            </td>
                          ),
                        )}
                        <td className={styles.actionsCell}>
                          <div className={styles.rowActions}>
                            {r.status === 'ACTIVE' ? (
                              <Tooltip content="Pause on Facebook" wrapsControl>
                                <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} disabled={busy === r.id} aria-label={`Pause ${r.name}`} onClick={() => void toggleActive(r, false)}>
                                  {busy === r.id ? '…' : <IconPause size={15} />}
                                </button>
                              </Tooltip>
                            ) : r.status === 'PAUSED' ? (
                              <Tooltip content="Resume on Facebook" wrapsControl>
                                <button type="button" className={styles.iconBtn} disabled={busy === r.id} aria-label={`Resume ${r.name}`} onClick={() => void toggleActive(r, true)}>
                                  {busy === r.id ? '…' : <IconPlay size={15} />}
                                </button>
                              </Tooltip>
                            ) : (
                              <span className={styles.iconBtnSpacer} aria-hidden />
                            )}
                            <Tooltip content="Open campaign — edit, budget, Sent to Google" wrapsControl>
                              <Link href={`/dashboard/campaigns/${r.id}`} className={styles.iconBtn} aria-label={`Open ${r.name}`}>
                                <IconExternal size={15} />
                              </Link>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr id={detailId} className={styles.detailRow}>
                          <td colSpan={colSpan}>
                            <div className={styles.detailPin}>
                              <CampaignDetail campaignId={r.id} bd={breakdowns[r.id]} range={range} onError={setError} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </FragmentRow>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className={styles.totalsRow}>
                  <th scope="row" className={`${admin.thLeft} ${styles.nameCell}`}>
                    Total · {fmtCount(filtered.length)}
                  </th>
                  <td className={styles.statusCol} />
                  {visibleCols.map((c) => (
                    <td key={c.key} className={`${admin.num} ${groupStarts.has(c.key) ? styles.groupStart : ''} ${c.key === 'budget' ? '' : (c.tone?.(totals) ?? '')}`}>
                      {c.key === 'budget' ? '' : c.cell(totals, null)}
                    </td>
                  ))}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className={styles.pager}>
            <span className={styles.pageInfo}>
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <button type="button" className={styles.pagerBtn} disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Prev
            </button>
            <button type="button" className={styles.pagerBtn} disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }): React.ReactNode {
  return <>{children}</>;
}
