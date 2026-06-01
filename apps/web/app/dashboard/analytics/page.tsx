'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type CampaignBreakdown,
  type CampaignPerf,
  type DimStat,
  type OfferStat,
  addBusinessDays,
  currentBusinessDay,
  formatRoi,
  formatUsd,
} from '@knn/shared';
import {
  Badge,
  Banner,
  Button,
  type DateRange,
  DateRangePicker,
  EmptyState,
  type SearchOption,
  SearchSelect,
  Segmented,
  Skeleton,
} from '@/components/ui';
import { campaigns as campaignApi, stats } from '@/lib/api';
import { useAuth } from '../../providers';
import admin from '../admin.module.css';
import styles from '../analytics.module.css';

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

// Derived per-row optimization metrics.
const ctr = (r: CampaignPerf): number => (r.impressions ? (r.clicks / r.impressions) * 100 : 0);
const cpc = (r: CampaignPerf): number => (r.clicks ? r.spendUsd / r.clicks : 0);
const cpa = (r: CampaignPerf): number => (r.conversions ? r.spendUsd / r.conversions : 0);
const rpc = (r: CampaignPerf): number => (r.clicks ? r.revenueUsd / r.clicks : 0);

type SortKey =
  | 'name' | 'status' | 'buyerName' | 'companyName'
  | 'spendUsd' | 'revenueUsd' | 'profitUsd' | 'roi' | 'conversions' | 'cpa' | 'clicks' | 'cpc' | 'ctr' | 'impressions' | 'rpc';

function metric(r: CampaignPerf, key: SortKey): number | string {
  switch (key) {
    case 'name': return r.name.toLowerCase();
    case 'status': return r.status;
    case 'buyerName': return r.buyerName.toLowerCase();
    case 'companyName': return r.companyName.toLowerCase();
    case 'cpa': return cpa(r);
    case 'cpc': return cpc(r);
    case 'ctr': return ctr(r);
    case 'rpc': return rpc(r);
    default: return r[key];
  }
}

const PAGE_SIZE = 50;

export default function AnalyticsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'SUPER_ADMIN' || user?.role === 'COMPANY_ADMIN';
  const isSuper = user?.role === 'SUPER_ADMIN';

  const [range, setRange] = useState<DateRange>(() => rangeFor(30));
  const [rows, setRows] = useState<CampaignPerf[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set());
  const [buyerSel, setBuyerSel] = useState('');
  const [companySel, setCompanySel] = useState('');
  const [profitSel, setProfitSel] = useState<'all' | 'profit' | 'loss'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('spendUsd');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [breakdowns, setBreakdowns] = useState<Record<string, CampaignBreakdown>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (r: DateRange, silent = false) => {
    if (!silent) setRows(null);
    setError(null);
    try {
      setRows(await stats.campaigns(r));
    } catch {
      setError('Could not load campaigns. Retrying shortly…');
    }
  }, []);

  useEffect(() => {
    void load(range);
    const id = setInterval(() => void load(range, true), 60_000);
    return () => clearInterval(id);
  }, [range, load]);

  // Debounce the free-text search (~200ms) so filtering/paging doesn't churn on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(id);
  }, [search]);

  // Reset to the first page whenever the filtered view changes.
  useEffect(() => setPage(0), [debouncedSearch, statusSel, buyerSel, companySel, profitSel, range]);

  const statuses = useMemo(() => [...new Set((rows ?? []).map((r) => r.status))].sort(), [rows]);
  const buyers = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) m.set(r.buyerId, r.buyerName);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);
  const companies = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) m.set(r.orgId, r.companyName);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // SearchSelect options, with an "All …" sentinel mapped to the empty-string (= no filter) value.
  const buyerOptions = useMemo<SearchOption[]>(
    () => [{ value: '', label: 'All buyers' }, ...buyers.map((b) => ({ value: b.id, label: b.name }))],
    [buyers],
  );
  const companyOptions = useMemo<SearchOption[]>(
    () => [{ value: '', label: 'All companies' }, ...companies.map((c) => ({ value: c.id, label: c.name }))],
    [companies],
  );

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
      const av = metric(a, sortKey);
      const bv = metric(b, sortKey);
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (av - bv) * dir;
    });
  }, [rows, debouncedSearch, statusSel, buyerSel, companySel, profitSel, sortKey, sortDir]);

  const totals = useMemo(() => {
    const t = filtered.reduce(
      (acc, r) => {
        acc.spend += r.spendUsd;
        acc.revenue += r.revenueUsd;
        acc.profit += r.profitUsd;
        acc.conv += r.conversions;
        acc.clicks += r.clicks;
        acc.impr += r.impressions;
        return acc;
      },
      { spend: 0, revenue: 0, profit: 0, conv: 0, clicks: 0, impr: 0 },
    );
    return {
      ...t,
      roi: t.spend ? (t.revenue - t.spend) / t.spend : 0,
      cpa: t.conv ? t.spend / t.conv : 0,
      cpc: t.clicks ? t.spend / t.clicks : 0,
      ctr: t.impr ? (t.clicks / t.impr) * 100 : 0,
      rpc: t.clicks ? t.revenue / t.clicks : 0,
    };
  }, [filtered]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const sortBy = (key: SortKey): void => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(typeof metric(rows?.[0] ?? ({} as CampaignPerf), key) === 'string' ? 'asc' : 'desc');
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

  const exportCsv = (): void => {
    const head = ['Campaign', 'Status', 'Buyer', 'Company', 'Spend', 'Revenue', 'Profit', 'ROI %', 'Conversions', 'CPA', 'Clicks', 'CPC', 'CTR%', 'Impressions', 'RPC', 'Channel'];
    const esc = (v: string | number): string => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      head.join(','),
      ...filtered.map((r) =>
        [r.name, r.status, r.buyerName, r.companyName, r.spendUsd, r.revenueUsd, r.profitUsd, (r.roi * 100).toFixed(1), r.conversions, cpa(r).toFixed(2), r.clicks, cpc(r).toFixed(2), ctr(r).toFixed(2), r.impressions, rpc(r).toFixed(2), r.channelLabel ?? '']
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

  const num = (n: number): string => formatUsd(n);
  const arrow = (key: SortKey): string => (sortKey !== key ? '' : sortDir === 'asc' ? '▲' : '▼');
  const colSpan = 14 + (isAdmin ? 1 : 0) + (isSuper ? 1 : 0); // total columns incl. actions

  const clearAllFilters = (): void => {
    setSearch('');
    setDebouncedSearch('');
    setStatusSel(new Set());
    setBuyerSel('');
    setCompanySel('');
    setProfitSel('all');
  };
  const hasFilters = search !== '' || statusSel.size > 0 || buyerSel !== '' || companySel !== '' || profitSel !== 'all';

  const Th = ({ k, label, lowPriority }: { k: SortKey; label: string; lowPriority?: boolean }): React.ReactNode => {
    const active = sortKey === k;
    return (
      <th
        className={`${admin.thLeft} ${styles.sortable} ${lowPriority ? styles.lowPriority : ''}`}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button type="button" className={styles.sortBtn} onClick={() => sortBy(k)}>
          {label}
          <span className={styles.arrow} aria-hidden>
            {arrow(k)}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div className={admin.page}>
      <div className={admin.head}>
        <div>
          <span className="eyebrow">Analytics</span>
          <h1 className={`serif ${admin.title}`}>Performance</h1>
          <p className={admin.sub}>Every campaign with the metrics that drive optimization. Filter, sort, search — then pause losers and scale winners.</p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {/* Toolbar: search + filters */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarRow}>
          <input
            className={styles.search}
            placeholder="Search campaign, channel, or buyer…"
            aria-label="Search campaigns"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
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
          {rows && (
            <span className={styles.resultCount} aria-live="polite">
              {filtered.length.toLocaleString()} {filtered.length === 1 ? 'campaign' : 'campaigns'}
            </span>
          )}
          <button type="button" className={admin.actionBtn} onClick={exportCsv} disabled={filtered.length === 0}>
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
          description={
            hasFilters
              ? 'No campaigns match the current filters. Clear them or widen the date range.'
              : 'No campaign performance in this date range yet. Try a wider range.'
          }
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
          <div className={`${admin.tableWrap} ${styles.tableScroll}`}>
            <table className={admin.table}>
              <thead>
                <tr>
                  <Th k="name" label="Campaign" />
                  <Th k="status" label="Status" />
                  {isAdmin && <Th k="buyerName" label="Buyer" />}
                  {isSuper && <Th k="companyName" label="Company" />}
                  <Th k="spendUsd" label="Spend" />
                  <Th k="revenueUsd" label="Revenue" />
                  <Th k="profitUsd" label="Profit" />
                  <Th k="roi" label="ROI" />
                  <Th k="conversions" label="Conv" />
                  <Th k="cpa" label="CPA" />
                  <Th k="clicks" label="Clicks" />
                  <Th k="cpc" label="CPC" lowPriority />
                  <Th k="ctr" label="CTR" lowPriority />
                  <Th k="impressions" label="Impr" lowPriority />
                  <Th k="rpc" label="RPC" lowPriority />
                  <th aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => {
                  const open = expanded === r.id;
                  const bd = breakdowns[r.id];
                  const detailId = `analytics-detail-${r.id}`;
                  return (
                    <FragmentRow key={r.id}>
                      <tr className={open ? styles.rowOpen : undefined}>
                        <td className={admin.name}>
                          <button
                            type="button"
                            className={styles.discloseBtn}
                            aria-expanded={open}
                            aria-controls={open ? detailId : undefined}
                            onClick={() => void toggleExpand(r.id)}
                          >
                            <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`} aria-hidden>
                              ▸
                            </span>
                            <span className={styles.discloseName}>
                              {r.name}
                              {r.channelLabel && <span className={admin.subtle}>{r.channelLabel}</span>}
                            </span>
                          </button>
                        </td>
                        <td>
                          <Badge tone={STATUS_TONE[r.status] ?? 'neutral'} dot>
                            {statusLabel(r.status)}
                          </Badge>
                        </td>
                        {isAdmin && <td className={admin.subtle}>{r.buyerName}</td>}
                        {isSuper && <td className={admin.subtle}>{r.companyName}</td>}
                        <td className={admin.num}>{num(r.spendUsd)}</td>
                        <td className={admin.num}>{num(r.revenueUsd)}</td>
                        <td className={`${admin.num} ${r.profitUsd > 0 ? styles.pos : r.profitUsd < 0 ? styles.neg : ''}`}>{num(r.profitUsd)}</td>
                        <td className={`${admin.num} ${r.roi > 0 ? styles.pos : r.roi < 0 ? styles.neg : ''}`}>{formatRoi(r.roi)}</td>
                        <td className={admin.num}>{r.conversions.toLocaleString()}</td>
                        <td className={admin.num}>{r.conversions ? num(cpa(r)) : '—'}</td>
                        <td className={admin.num}>{r.clicks.toLocaleString()}</td>
                        <td className={`${admin.num} ${styles.lowPriority}`}>{r.clicks ? num(cpc(r)) : '—'}</td>
                        <td className={`${admin.num} ${styles.lowPriority}`}>{ctr(r).toFixed(2)}%</td>
                        <td className={`${admin.num} ${styles.lowPriority}`}>{r.impressions.toLocaleString()}</td>
                        <td className={`${admin.num} ${styles.lowPriority}`}>{r.clicks ? num(rpc(r)) : '—'}</td>
                        <td>
                          {r.status === 'ACTIVE' ? (
                            <button type="button" className={`${admin.actionBtn} ${admin.actionDanger}`} disabled={busy === r.id} onClick={() => void toggleActive(r, false)}>
                              {busy === r.id ? '…' : 'Pause'}
                            </button>
                          ) : r.status === 'PAUSED' ? (
                            <button type="button" className={admin.actionBtn} disabled={busy === r.id} onClick={() => void toggleActive(r, true)}>
                              {busy === r.id ? '…' : 'Resume'}
                            </button>
                          ) : (
                            <span className={admin.subtle}>—</span>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr id={detailId}>
                          <td colSpan={colSpan}>
                            <CampaignDetail campaignId={r.id} bd={bd} range={range} />
                          </td>
                        </tr>
                      )}
                    </FragmentRow>
                  );
                })}
                {/* Totals over the full filtered set (not just this page). */}
                <tr className={styles.totalsRow}>
                  <td className={admin.name}>Totals ({filtered.length})</td>
                  <td></td>
                  {isAdmin && <td></td>}
                  {isSuper && <td></td>}
                  <td className={admin.num}>{num(totals.spend)}</td>
                  <td className={admin.num}>{num(totals.revenue)}</td>
                  <td className={`${admin.num} ${totals.profit >= 0 ? styles.pos : styles.neg}`}>{num(totals.profit)}</td>
                  <td className={admin.num}>{formatRoi(totals.roi)}</td>
                  <td className={admin.num}>{totals.conv.toLocaleString()}</td>
                  <td className={admin.num}>{totals.conv ? num(totals.cpa) : '—'}</td>
                  <td className={admin.num}>{totals.clicks.toLocaleString()}</td>
                  <td className={`${admin.num} ${styles.lowPriority}`}>{totals.clicks ? num(totals.cpc) : '—'}</td>
                  <td className={`${admin.num} ${styles.lowPriority}`}>{totals.ctr.toFixed(2)}%</td>
                  <td className={`${admin.num} ${styles.lowPriority}`}>{totals.impr.toLocaleString()}</td>
                  <td className={`${admin.num} ${styles.lowPriority}`}>{totals.clicks ? num(totals.rpc) : '—'}</td>
                  <td></td>
                </tr>
              </tbody>
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

// Generic per-row derived metrics (works for ad sets + ads, which share these fields).
type Metricable = { spendUsd: number; revenueUsd: number; impressions: number; clicks: number; conversions: number };
const dCpa = (r: Metricable): string => (r.conversions ? formatUsd(r.spendUsd / r.conversions) : '—');
const dCpc = (r: Metricable): string => (r.clicks ? formatUsd(r.spendUsd / r.clicks) : '—');
const dCtr = (r: Metricable): string => `${(r.impressions ? (r.clicks / r.impressions) * 100 : 0).toFixed(2)}%`;

/** The expandable campaign panel: a Campaign→AdSet→Ad tree + a per-offer/domain view. */
function CampaignDetail({ campaignId, bd, range }: { campaignId: string; bd: CampaignBreakdown | undefined; range: DateRange }): React.ReactNode {
  const [tab, setTab] = useState<'structure' | 'offers' | 'country' | 'hour'>('structure');
  const [offers, setOffers] = useState<OfferStat[] | null>(null);
  const [dim, setDim] = useState<{ country: DimStat[] | null; hour: DimStat[] | null }>({ country: null, hour: null });

  useEffect(() => {
    if (tab === 'offers' && offers === null) {
      void stats.campaignOffers(campaignId, range).then(setOffers).catch(() => setOffers([]));
    }
    if ((tab === 'country' || tab === 'hour') && dim[tab] === null) {
      void stats
        .campaignDim(campaignId, tab, range)
        .then((rows) => setDim((d) => ({ ...d, [tab]: rows })))
        .catch(() => setDim((d) => ({ ...d, [tab]: [] })));
    }
  }, [tab, offers, dim, campaignId, range]);

  const money = (n: number): string => formatUsd(n);
  const dimRows = tab === 'country' ? dim.country : tab === 'hour' ? dim.hour : null;

  return (
    <div className={styles.detail}>
      <div className={styles.detailTabs}>
        <button type="button" className={`${styles.detailTab} ${tab === 'structure' ? styles.detailTabActive : ''}`} onClick={() => setTab('structure')}>
          Structure (ad sets → ads)
        </button>
        <button type="button" className={`${styles.detailTab} ${tab === 'offers' ? styles.detailTabActive : ''}`} onClick={() => setTab('offers')}>
          By offer / domain
        </button>
        <button type="button" className={`${styles.detailTab} ${tab === 'country' ? styles.detailTabActive : ''}`} onClick={() => setTab('country')}>
          By country
        </button>
        <button type="button" className={`${styles.detailTab} ${tab === 'hour' ? styles.detailTabActive : ''}`} onClick={() => setTab('hour')}>
          By hour
        </button>
      </div>

      {tab === 'country' || tab === 'hour' ? (
        dimRows === null ? (
          <Skeleton className={admin.rowSkel} />
        ) : dimRows.length === 0 ? (
          <p className={admin.subtle}>No {tab} data yet — populates once the campaign is delivering on Facebook.</p>
        ) : (
          <table className={admin.table}>
            <thead>
              <tr>
                <th className={admin.thLeft}>{tab === 'country' ? 'Country' : 'Hour'}</th>
                <th className={admin.thLeft}>Spend</th>
                <th className={admin.thLeft}>Revenue*</th>
                <th className={admin.thLeft}>Profit</th>
                <th className={admin.thLeft}>ROI</th>
                <th className={admin.thLeft}>Conv</th>
                <th className={admin.thLeft}>CPA</th>
                <th className={admin.thLeft}>CPC</th>
                <th className={admin.thLeft}>CTR</th>
              </tr>
            </thead>
            <tbody>
              {dimRows.map((d) => (
                <tr key={d.dimValue}>
                  <td className={admin.name}>{d.dimValue}</td>
                  <td>{money(d.spendUsd)}</td>
                  <td>{money(d.revenueUsd)}</td>
                  <td className={d.profitUsd >= 0 ? styles.pos : styles.neg}>{money(d.profitUsd)}</td>
                  <td>{formatRoi(d.roi)}</td>
                  <td>{d.conversions.toLocaleString()}</td>
                  <td>{dCpa(d)}</td>
                  <td>{dCpc(d)}</td>
                  <td>{dCtr(d)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={9} className={admin.subtle}>
                  * Revenue is allocated across {tab === 'country' ? 'countries' : 'hours'} by conversion share — AFS revenue isn&apos;t geo/hour-tagged, so this is an estimate (spend &amp; conversions are exact).
                </td>
              </tr>
            </tbody>
          </table>
        )
      ) : tab === 'structure' ? (
        !bd ? (
          <Skeleton className={admin.rowSkel} />
        ) : bd.adSets.length === 0 ? (
          <p className={admin.subtle}>No ad sets.</p>
        ) : (
          <table className={admin.table}>
            <thead>
              <tr>
                <th className={admin.thLeft}>Ad set / Ad</th>
                <th className={admin.thLeft}>Spend</th>
                <th className={admin.thLeft}>Revenue</th>
                <th className={admin.thLeft}>Profit</th>
                <th className={admin.thLeft}>ROI</th>
                <th className={admin.thLeft}>Conv</th>
                <th className={admin.thLeft}>CPA</th>
                <th className={admin.thLeft}>CPC</th>
                <th className={admin.thLeft}>CTR</th>
              </tr>
            </thead>
            <tbody>
              {bd.adSets.map((set) => (
                <FragmentRow key={set.id}>
                  <tr className={styles.setRow}>
                    <td>{set.name}</td>
                    <td>{money(set.spendUsd)}</td>
                    <td>{money(set.revenueUsd)}</td>
                    <td className={set.profitUsd >= 0 ? styles.pos : styles.neg}>{money(set.profitUsd)}</td>
                    <td>{formatRoi(set.roi)}</td>
                    <td>{set.conversions.toLocaleString()}</td>
                    <td>{dCpa(set)}</td>
                    <td>{dCpc(set)}</td>
                    <td>{dCtr(set)}</td>
                  </tr>
                  {set.ads.map((ad) => (
                    <tr key={ad.id}>
                      <td className={styles.adIndent}>{ad.name}</td>
                      <td>{money(ad.spendUsd)}</td>
                      <td>{money(ad.revenueUsd)}</td>
                      <td className={ad.profitUsd >= 0 ? styles.pos : styles.neg}>{money(ad.profitUsd)}</td>
                      <td>{formatRoi(ad.roi)}</td>
                      <td>{ad.conversions.toLocaleString()}</td>
                      <td>{dCpa(ad)}</td>
                      <td>{dCpc(ad)}</td>
                      <td>{dCtr(ad)}</td>
                    </tr>
                  ))}
                </FragmentRow>
              ))}
            </tbody>
          </table>
        )
      ) : offers === null ? (
        <Skeleton className={admin.rowSkel} />
      ) : offers.length === 0 ? (
        <p className={admin.subtle}>No offers on this campaign (single-domain or legacy).</p>
      ) : (
        <table className={admin.table}>
          <thead>
            <tr>
              <th className={admin.thLeft}>Domain</th>
              <th className={admin.thLeft}>Kind</th>
              <th className={admin.thLeft}>Weight</th>
              <th className={admin.thLeft}>Revenue</th>
              <th className={admin.thLeft}>AFS clicks</th>
              <th className={admin.thLeft}>RPC</th>
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.offerId}>
                <td className={admin.name}>{o.host}</td>
                <td className={admin.subtle}>{o.kind === 'PAID' ? 'Paid' : 'Organic'}</td>
                <td>{o.weightPct}%</td>
                <td>{money(o.revenueUsd)}</td>
                <td>{o.suppressed ? <span className={styles.suppressed}>&lt;10/day</span> : o.afsClicks.toLocaleString()}</td>
                <td>{!o.suppressed && o.afsClicks ? money(o.revenueUsd / o.afsClicks) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
