'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  type CampaignBreakdown,
  type CampaignPerf,
  type StatsSummary,
  addBusinessDays,
  currentBusinessDay,
  formatRoi,
  formatUsd,
  formatUsdCompact,
} from '@knn/shared';
import {
  Badge,
  Banner,
  Button,
  Card,
  type DateRange,
  DateRangePicker,
  EmptyState,
  Skeleton,
  StatTile,
} from '@/components/ui';
import { RevenueChart, Sparkline } from '@/components/charts';
import { FbStatusBadge } from '@/components/fb-status-badge';
import { stats } from '@/lib/api';
import { useAuth } from '../providers';
import styles from './overview.module.css';

function rangeFor(days: number): DateRange {
  const to = currentBusinessDay();
  return { from: addBusinessDays(to, -(days - 1)), to };
}

function relTime(from: number, now: number): string {
  const secs = Math.max(0, Math.round((now - from) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

function roiTone(roi: number): 'pos' | 'neg' | 'neutral' {
  // Break-even is 0% (profit-based ROI). Above = profitable, below = losing.
  if (roi > 0) return 'pos';
  if (roi < 0) return 'neg';
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
  const header = ['Campaign', 'Status', 'Channel', 'Spend', 'Revenue', 'Profit', 'ROI %', 'Impressions', 'Clicks', 'Conversions'];
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    header.join(','),
    ...rows.map((r) =>
      [r.name, r.status, r.channelLabel ?? '', r.spendUsd, r.revenueUsd, r.profitUsd, (r.roi * 100).toFixed(1), r.impressions, r.clicks, r.conversions]
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [breakdowns, setBreakdowns] = useState<Record<string, CampaignBreakdown>>({});
  const [breakdownErrors, setBreakdownErrors] = useState<Record<string, boolean>>({});
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const isAdmin = user?.role === 'SUPER_ADMIN' || user?.role === 'COMPANY_ADMIN';
  const scopeWord = user?.role === 'SUPER_ADMIN' ? 'platform' : user?.role === 'COMPANY_ADMIN' ? 'organization' : 'campaigns';

  const load = useCallback(async (r: DateRange, silent = false) => {
    if (!silent) {
      setLoading(true);
      setSummary(null);
      setCampaigns(null);
    }
    setError(null);
    try {
      const [s, c] = await Promise.all([stats.summary(r), stats.campaigns(r)]);
      setSummary(s);
      setCampaigns(c);
      setLastUpdated(Date.now());
    } catch {
      setError('Could not load your metrics. Check your connection and try again.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
    setExpanded(null);
    setBreakdowns({});
    setBreakdownErrors({});
    const id = setInterval(() => void load(range, true), 60_000);
    return () => clearInterval(id);
  }, [range, load]);

  // Tick the "Updated Xs ago" label so it stays accurate between refreshes.
  useEffect(() => {
    if (lastUpdated === null) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  const loadBreakdown = useCallback(
    async (id: string): Promise<void> => {
      setBreakdownErrors((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      try {
        const b = await stats.campaignBreakdown(id, range);
        setBreakdowns((prev) => ({ ...prev, [id]: b }));
      } catch {
        // Surface an inline error + retry in the detail cell rather than
        // leaving a forever-shimmering skeleton.
        setBreakdownErrors((prev) => ({ ...prev, [id]: true }));
      }
    },
    [range],
  );

  const toggle = async (id: string): Promise<void> => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!breakdowns[id] && !breakdownErrors[id]) {
      await loadBreakdown(id);
    }
  };

  const firstName = user?.name.split(' ')[0] ?? 'there';
  const t = summary?.totals;
  const series = summary?.series ?? [];

  // "Decisions, not data" — derive what needs the buyer's attention from the campaigns we already
  // have (no extra fetch): money-losers, Facebook rejections, and the top performer to scale.
  const attention = useMemo(() => {
    type Item = { key: string; tone: 'danger' | 'warning' | 'success'; icon: string; label: string; detail?: string; href: string; cta: string };
    const items: Item[] = [];
    if (!campaigns || campaigns.length === 0) return items;
    const losers = campaigns.filter((c) => c.status === 'ACTIVE' && c.spendUsd > 0 && c.profitUsd < 0);
    if (losers.length > 0) {
      const bleed = losers.reduce((s, c) => s + c.profitUsd, 0);
      items.push({ key: 'losing', tone: 'danger', icon: '↘', label: `${losers.length} active campaign${losers.length === 1 ? ' is' : 's are'} losing money`, detail: `${formatUsd(bleed)} combined this period — pause or fix them`, href: '/dashboard/analytics', cta: 'Review' });
    }
    const rejected = campaigns.filter((c) => c.status === 'META_REJECTED' || c.status === 'REJECTED');
    if (rejected.length > 0) {
      items.push({ key: 'rejected', tone: 'danger', icon: '!', label: `${rejected.length} campaign${rejected.length === 1 ? ' was' : 's were'} rejected by Facebook`, detail: 'Fix the creative, then relaunch', href: '/dashboard/campaigns', cta: 'Fix' });
    }
    const winners = campaigns.filter((c) => c.status === 'ACTIVE' && c.profitUsd > 0 && c.roi > 0.2);
    if (winners.length > 0) {
      const top = winners.reduce((a, b) => (b.profitUsd > a.profitUsd ? b : a));
      items.push({ key: 'winner', tone: 'success', icon: '↗', label: `“${top.name}” is profitable at ${formatRoi(top.roi)} ROI`, detail: `${formatUsd(top.profitUsd)} profit — consider scaling its budget`, href: '/dashboard/analytics', cta: 'Scale' });
    }
    return items;
  }, [campaigns]);

  // A brand-new buyer with zero campaigns: this is the #1 conversion moment, so
  // we lead with an activation CTA and de-emphasize the (all-zero) KPIs + chart.
  const isNewBuyer = !error && !loading && campaigns !== null && campaigns.length === 0;
  // Hard failure (not a transient background refresh): show explicit error
  // placeholders + Retry rather than a forever-shimmering skeleton.
  const isError = !!error && (summary === null || campaigns === null);

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Overview</span>
          <h1 className={`serif ${styles.title}`}>Hello, {firstName}.</h1>
          <p className={styles.sub}>Real-time ROI across your {scopeWord}.</p>
        </div>
        <div className={styles.headControls}>
          <DateRangePicker value={range} onChange={setRange} />
          <div className={styles.freshness} aria-live="polite">
            {lastUpdated !== null && (
              <>
                <span className={styles.freshDot} aria-hidden />
                <span>Updated {relTime(lastUpdated, now)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {error && (
        <Banner
          tone="error"
          title="Couldn’t load your metrics"
          action={
            <Button variant="secondary" loading={loading} onClick={() => void load(range)}>
              Retry
            </Button>
          }
        >
          {error}
        </Banner>
      )}

      {isError ? (
        <Card className={styles.stateCard}>
          <EmptyState
            title="We hit a snag loading this dashboard"
            description="Your metrics couldn’t be fetched. This is usually temporary — try again."
            action={
              <Button loading={loading} onClick={() => void load(range)}>
                Retry
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {isNewBuyer && (
            <Card className={styles.stateCard}>
              <EmptyState
                title="Launch your first campaign"
                description="Pick your keywords, attach an article, and go live. As soon as traffic flows you’ll see real-time spend, revenue, and ROI right here."
                action={
                  <Link href="/dashboard/campaigns/new" className={styles.ctaLink}>
                    <Button>New campaign</Button>
                  </Link>
                }
              />
            </Card>
          )}

          {!isNewBuyer && attention.length > 0 && (
            <Card className={styles.attentionCard}>
              <div className={styles.attentionHead}>
                <span className={styles.cardTitle}>Needs attention</span>
              </div>
              <ul className={styles.attentionList}>
                {attention.map((a) => (
                  <li key={a.key} className={`${styles.attentionItem} ${styles[`att-${a.tone}`]}`}>
                    <span className={styles.attIcon} aria-hidden>
                      {a.icon}
                    </span>
                    <span className={styles.attBody}>
                      <span className={styles.attLabel}>{a.label}</span>
                      {a.detail && <span className={styles.attDetail}>{a.detail}</span>}
                    </span>
                    <Link href={a.href} className={styles.attCta}>
                      {a.cta} →
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* KPI tiles — dimmed while a brand-new account has no real data yet */}
          <div className={`${styles.kpis} ${isNewBuyer ? styles.deEmphasized : ''}`}>
            {t ? (
              <>
                <StatTile
                  label="Revenue"
                  value={formatUsdCompact(t.revenueUsd)}
                  valueTitle={formatUsd(t.revenueUsd)}
                  spark={<Sparkline values={series.map((p) => p.revenueUsd)} tone="gold" />}
                />
                <StatTile
                  label="Ad Spend"
                  value={formatUsdCompact(t.spendUsd)}
                  valueTitle={formatUsd(t.spendUsd)}
                  spark={<Sparkline values={series.map((p) => p.spendUsd)} tone="rust" />}
                />
                <StatTile
                  label="Profit"
                  value={formatUsdCompact(t.profitUsd)}
                  valueTitle={formatUsd(t.profitUsd)}
                  tone={t.profitUsd > 0 ? 'pos' : t.profitUsd < 0 ? 'neg' : 'neutral'}
                  sub={t.profitUsd >= 0 ? 'In the green' : 'In the red'}
                  spark={<Sparkline values={series.map((p) => p.profitUsd)} tone="green" />}
                />
                <StatTile
                  label="ROI"
                  value={formatRoi(t.roi)}
                  valueTitle={`${formatRoi(t.roi)} net return (profit ÷ spend)`}
                  tone={roiTone(t.roi)}
                  sub={t.roi < 0 ? 'Below break-even' : `${t.conversions.toLocaleString()} conversions`}
                />
                {isAdmin && (
                  <StatTile
                    label="Platform Margin"
                    value={formatUsdCompact(t.marginUsd)}
                    valueTitle={formatUsd(t.marginUsd)}
                    sub="Your cut"
                  />
                )}
              </>
            ) : (
              Array.from({ length: isAdmin ? 5 : 4 }).map((_, i) => <Skeleton key={i} className={styles.kpiSkel} />)
            )}
          </div>

          {/* Revenue vs spend chart */}
          <Card className={`${styles.chartCard} ${isNewBuyer ? styles.deEmphasized : ''}`}>
            <div className={styles.chartHead}>
              <span className={styles.cardTitle}>Revenue vs. Spend</span>
              {/* Legend is rendered inside <RevenueChart> (colorblind-safe: solid vs dashed). */}
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
                        <CampaignRows
                          key={c.id}
                          c={c}
                          open={open}
                          bd={bd}
                          failed={!!breakdownErrors[c.id]}
                          onToggle={() => void toggle(c.id)}
                          onRetry={() => void loadBreakdown(c.id)}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
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
  failed,
  onToggle,
  onRetry,
}: {
  c: CampaignPerf;
  open: boolean;
  bd: CampaignBreakdown | undefined;
  failed: boolean;
  onToggle: () => void;
  onRetry: () => void;
}) {
  const detailId = `${useId()}-detail`;
  const flag: 'losing' | 'winner' | null =
    c.status === 'ACTIVE' && c.spendUsd > 0 ? (c.profitUsd < 0 ? 'losing' : c.roi > 0.2 ? 'winner' : null) : null;
  return (
    <>
      <tr className={`${styles.row} ${open ? styles.rowOpen : ''}`}>
        <td className={styles.tdName}>
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={open}
            aria-controls={detailId}
            onClick={onToggle}
          >
            <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`} aria-hidden>
              ▸
            </span>
            <span className={styles.cName}>{c.name}</span>
          </button>
          {flag === 'losing' && <span className={styles.flagLosing}>Losing</span>}
          {flag === 'winner' && <span className={styles.flagWinner}>Winner</span>}
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
        <td className={`${styles.num} ${c.roi > 0 ? styles.pos : c.roi < 0 ? styles.neg : ''}`}>{formatRoi(c.roi)}</td>
        <td className={styles.num}>{c.conversions.toLocaleString()}</td>
      </tr>
      {open && (
        <tr className={styles.detailRow} id={detailId}>
          <td colSpan={7}>
            {failed ? (
              <div className={styles.detailError} role="alert">
                <span className={styles.detailErrorText}>Couldn’t load this breakdown.</span>
                <Button variant="ghost" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            ) : !bd ? (
              <Skeleton className={styles.detailSkel} />
            ) : bd.adSets.length === 0 ? (
              <p className={styles.detailEmpty}>No ad sets.</p>
            ) : (
              <div className={styles.detail}>
                {bd.adSets.map((set) => (
                  <div key={set.id} className={styles.adSet}>
                    <div className={styles.adSetName}>
                      {set.name} <FbStatusBadge status={set.effectiveStatus} />
                    </div>
                    {set.ads.map((ad) => (
                      <div key={ad.id} className={styles.adRow}>
                        <span className={styles.adName}>
                          {ad.name} <FbStatusBadge status={ad.effectiveStatus} />
                        </span>
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
