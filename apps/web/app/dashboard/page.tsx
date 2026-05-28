'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  type CampaignBreakdown,
  type CampaignPerf,
  type StatsSummary,
  addBusinessDays,
  currentBusinessDay,
  formatUsd,
} from '@knn/shared';
import { Badge, Card, type DateRange, DateRangePicker, Skeleton, StatTile } from '@/components/ui';
import { RevenueChart, Sparkline } from '@/components/charts';
import { stats } from '@/lib/api';
import { useAuth } from '../providers';
import styles from './overview.module.css';

function rangeFor(days: number): DateRange {
  const to = currentBusinessDay();
  return { from: addBusinessDays(to, -(days - 1)), to };
}

function roiTone(roi: number): 'pos' | 'neg' | 'neutral' {
  if (roi > 1) return 'pos';
  if (roi > 0 && roi < 1) return 'neg';
  return 'neutral';
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

function statusLabel(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function exportCsv(rows: CampaignPerf[]): void {
  const header = ['Campaign', 'Status', 'Channel', 'Spend', 'Revenue', 'Profit', 'ROI', 'Impressions', 'Clicks', 'Conversions'];
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    header.join(','),
    ...rows.map((r) =>
      [r.name, r.status, r.channelLabel ?? '', r.spendUsd, r.revenueUsd, r.profitUsd, r.roi, r.impressions, r.clicks, r.conversions]
        .map(esc)
        .join(','),
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `knn-campaigns-${currentBusinessDay()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DashboardHome() {
  const { user } = useAuth();
  const [range, setRange] = useState<DateRange>(() => rangeFor(7));
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignPerf[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [breakdowns, setBreakdowns] = useState<Record<string, CampaignBreakdown>>({});

  const isAdmin = user?.role === 'SUPER_ADMIN' || user?.role === 'COMPANY_ADMIN';
  const scopeWord = user?.role === 'SUPER_ADMIN' ? 'platform' : user?.role === 'COMPANY_ADMIN' ? 'organization' : 'campaigns';

  const load = useCallback(async (r: DateRange, silent = false) => {
    if (!silent) {
      setSummary(null);
      setCampaigns(null);
    }
    setError(null);
    try {
      const [s, c] = await Promise.all([stats.summary(r), stats.campaigns(r)]);
      setSummary(s);
      setCampaigns(c);
    } catch {
      setError('Could not load metrics. Retrying shortly…');
    }
  }, []);

  useEffect(() => {
    void load(range);
    setExpanded(null);
    setBreakdowns({});
    const id = setInterval(() => void load(range, true), 60_000);
    return () => clearInterval(id);
  }, [range, load]);

  const toggle = async (id: string): Promise<void> => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!breakdowns[id]) {
      try {
        const b = await stats.campaignBreakdown(id, range);
        setBreakdowns((prev) => ({ ...prev, [id]: b }));
      } catch {
        /* leave row expanded with a tiny error; non-critical */
      }
    }
  };

  const firstName = user?.name.split(' ')[0] ?? 'there';
  const t = summary?.totals;
  const series = summary?.series ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Overview</span>
          <h1 className={`serif ${styles.title}`}>Hello, {firstName}.</h1>
          <p className={styles.sub}>Real-time ROI across your {scopeWord}.</p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {error && <Card className={styles.errorCard}>{error}</Card>}

      {/* KPI tiles */}
      <div className={styles.kpis}>
        {t ? (
          <>
            <StatTile
              label="Revenue"
              value={formatUsd(t.revenueUsd)}
              spark={<Sparkline values={series.map((p) => p.revenueUsd)} tone="gold" />}
            />
            <StatTile
              label="Ad Spend"
              value={formatUsd(t.spendUsd)}
              spark={<Sparkline values={series.map((p) => p.spendUsd)} tone="rust" />}
            />
            <StatTile
              label="Profit"
              value={formatUsd(t.profitUsd)}
              tone={t.profitUsd > 0 ? 'pos' : t.profitUsd < 0 ? 'neg' : 'neutral'}
              sub={t.profitUsd >= 0 ? 'In the green' : 'In the red'}
              spark={<Sparkline values={series.map((p) => p.profitUsd)} tone="green" />}
            />
            <StatTile label="ROI" value={`${t.roi.toFixed(2)}×`} tone={roiTone(t.roi)} sub={`${t.conversions.toLocaleString()} conversions`} />
            {isAdmin && <StatTile label="Platform Margin" value={formatUsd(t.marginUsd)} sub="Your cut" />}
          </>
        ) : (
          Array.from({ length: isAdmin ? 5 : 4 }).map((_, i) => <Skeleton key={i} className={styles.kpiSkel} />)
        )}
      </div>

      {/* Revenue vs spend chart */}
      <Card className={styles.chartCard}>
        <div className={styles.chartHead}>
          <span className={styles.cardTitle}>Revenue vs. Spend</span>
          <div className={styles.legend}>
            <span className={styles.legRev}>Revenue</span>
            <span className={styles.legSpend}>Spend</span>
          </div>
        </div>
        {summary ? <RevenueChart series={series} /> : <Skeleton className={styles.chartSkel} />}
      </Card>

      {/* Campaign performance */}
      <Card className={styles.tableCard}>
        <div className={styles.tableHead}>
          <span className={styles.cardTitle}>Campaign performance</span>
          {campaigns && campaigns.length > 0 && (
            <button type="button" className={styles.csvBtn} onClick={() => exportCsv(campaigns)}>
              Export CSV
            </button>
          )}
        </div>
        {!campaigns ? (
          <div className={styles.rowsSkel}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className={styles.rowSkel} />
            ))}
          </div>
        ) : campaigns.length === 0 ? (
          <p className={styles.empty}>No campaigns yet. Launch one to start seeing performance here.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Campaign</th>
                  <th>Status</th>
                  <th className={styles.thNum}>Spend</th>
                  <th className={styles.thNum}>Revenue</th>
                  <th className={styles.thNum}>Profit</th>
                  <th className={styles.thNum}>ROI</th>
                  <th className={styles.thNum}>Conv.</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => {
                  const open = expanded === c.id;
                  const bd = breakdowns[c.id];
                  return (
                    <CampaignRows key={c.id} c={c} open={open} bd={bd} onToggle={() => void toggle(c.id)} />
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

function money(n: number): string {
  return formatUsd(n);
}

function CampaignRows({
  c,
  open,
  bd,
  onToggle,
}: {
  c: CampaignPerf;
  open: boolean;
  bd: CampaignBreakdown | undefined;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={`${styles.row} ${open ? styles.rowOpen : ''}`} onClick={onToggle}>
        <td className={styles.tdName}>
          <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`}>▸</span>
          <span className={styles.cName}>{c.name}</span>
          {c.channelLabel && <span className={styles.chTag}>{c.channelLabel}</span>}
          <span className={styles.adCount}>
            {c.adSetCount} set{c.adSetCount === 1 ? '' : 's'} · {c.adCount} ad{c.adCount === 1 ? '' : 's'}
          </span>
        </td>
        <td>
          <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{statusLabel(c.status)}</Badge>
        </td>
        <td className={styles.num}>{money(c.spendUsd)}</td>
        <td className={styles.num}>{money(c.revenueUsd)}</td>
        <td className={`${styles.num} ${c.profitUsd > 0 ? styles.pos : c.profitUsd < 0 ? styles.neg : ''}`}>{money(c.profitUsd)}</td>
        <td className={`${styles.num} ${c.roi > 1 ? styles.pos : c.roi > 0 && c.roi < 1 ? styles.neg : ''}`}>{c.roi.toFixed(2)}×</td>
        <td className={styles.num}>{c.conversions.toLocaleString()}</td>
      </tr>
      {open && (
        <tr className={styles.detailRow}>
          <td colSpan={7}>
            {!bd ? (
              <Skeleton className={styles.detailSkel} />
            ) : bd.adSets.length === 0 ? (
              <p className={styles.detailEmpty}>No ad sets.</p>
            ) : (
              <div className={styles.detail}>
                {bd.adSets.map((set) => (
                  <div key={set.id} className={styles.adSet}>
                    <div className={styles.adSetName}>{set.name}</div>
                    {set.ads.map((ad) => (
                      <div key={ad.id} className={styles.adRow}>
                        <span className={styles.adName}>{ad.name}</span>
                        <span className={styles.adMetric}>{money(ad.spendUsd)} spend</span>
                        <span className={styles.adMetric}>{money(ad.revenueUsd)} rev</span>
                        <span className={`${styles.adMetric} ${ad.profitUsd >= 0 ? styles.pos : styles.neg}`}>{money(ad.profitUsd)}</span>
                        <span className={styles.adMetric}>{ad.conversions} conv</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
