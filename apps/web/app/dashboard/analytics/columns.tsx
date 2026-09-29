import type { ReactNode } from 'react';
import {
  type CampaignPerf,
  costPer,
  epv,
  formatRate,
  formatRoi,
  formatUnitUsd,
  formatUsd,
  perVisit,
  rpcPerAdClick,
  vcvr,
} from '@knn/shared';
import styles from '../analytics.module.css';

/**
 * The Analytics column registry — the ONE place a metric is defined: its label, group, formula,
 * format, sort value, totals and plain-language definition (with the ClickFlare equivalent, so a
 * buyer comparing the two compares like with like). The table header, cells, totals row, column
 * picker and CSV export are all driven from here, so they can never disagree.
 */

/** The inputs every derived metric is computed from — a campaign row or the summed totals. */
export interface MetricInputs {
  spendUsd: number;
  revenueUsd: number;
  impressions: number;
  /** Visits = Facebook link clicks that reached the landing page. */
  clicks: number;
  /** Facebook-reported conversions (the pixel `Search` event = an ad click). */
  conversions: number;
  /** Visits that clicked a Google ad — our own tracking, live and never hidden (ClickFlare Conversions). */
  adClicks: number;
}

export const derive = {
  profit: (r: MetricInputs): number => r.revenueUsd - r.spendUsd,
  roi: (r: MetricInputs): number | null => (r.spendUsd > 0 ? (r.revenueUsd - r.spendUsd) / r.spendUsd : null),
  epv: (r: MetricInputs): number | null => epv(r.revenueUsd, r.clicks),
  cpc: (r: MetricInputs): number | null => costPer(r.spendUsd, r.clicks),
  rpc: (r: MetricInputs): number | null => rpcPerAdClick(r.revenueUsd, r.adClicks),
  vcvr: (r: MetricInputs): number | null => vcvr(r.adClicks, r.clicks),
  ctr: (r: MetricInputs): number | null => perVisit(r.clicks, r.impressions),
  cpa: (r: MetricInputs): number | null => costPer(r.spendUsd, r.conversions),
  cvrFb: (r: MetricInputs): number | null => perVisit(r.conversions, r.clicks),
};

/** Counts: exact below 10k, compact above (small numbers precise, big ones scannable). */
export function fmtCount(n: number): string {
  const a = Math.abs(n);
  if (a < 10_000) return n.toLocaleString('en-US');
  if (a < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Sum rows into totals inputs (ratios are then re-derived from the sums, never averaged). */
export function sumInputs(rows: readonly MetricInputs[]): MetricInputs {
  const t: MetricInputs = { spendUsd: 0, revenueUsd: 0, impressions: 0, clicks: 0, conversions: 0, adClicks: 0 };
  for (const r of rows) {
    t.spendUsd += r.spendUsd;
    t.revenueUsd += r.revenueUsd;
    t.impressions += r.impressions;
    t.clicks += r.clicks;
    t.conversions += r.conversions;
    t.adClicks += r.adClicks;
  }
  return t;
}

export type GroupKey = 'results' | 'unit' | 'traffic' | 'facebook' | 'controls';

export const GROUPS: Record<GroupKey, { label: string; info: string }> = {
  results: { label: 'Results', info: 'What the campaign spent and earned in the selected period.' },
  unit: {
    label: 'Per visit & per click',
    info: 'Unit economics, named exactly like ClickFlare. A campaign makes money when EPV (earned per visit) beats CPC (paid per visit).',
  },
  traffic: { label: 'Traffic', info: 'Visitors from Facebook and the Google ads they clicked.' },
  facebook: { label: 'Facebook', info: "Facebook's own conversion reporting — used for its optimization and CPA." },
  controls: { label: '', info: '' },
};

export type ColKey =
  | 'spend'
  | 'revenue'
  | 'profit'
  | 'roi'
  | 'epv'
  | 'cpc'
  | 'rpc'
  | 'vcvr'
  | 'visits'
  | 'adClicks'
  | 'impressions'
  | 'ctr'
  | 'conv'
  | 'cpa'
  | 'cvrFb'
  | 'budget';

export interface CellCtx {
  /** Largest spend / revenue in view, for the in-cell data bars. */
  maxSpend: number;
  maxRevenue: number;
}

export interface ColumnDef {
  key: ColKey;
  label: string;
  group: GroupKey;
  /** Plain-language definition + formula + ClickFlare equivalent (header tooltip). */
  info: string;
  /** Sort value (null sorts last). Omitted → not sortable. */
  sort?: (r: CampaignPerf) => number | null;
  /** A cell for a campaign row or the totals row. */
  cell: (r: MetricInputs, ctx: CellCtx | null) => ReactNode;
  /** Plain value for CSV. */
  csv: (r: MetricInputs) => string;
  /** Extra class for the <td>. */
  tone?: (r: MetricInputs) => string | undefined;
}

const toneOf = (n: number | null): string | undefined => (n === null || n === 0 ? undefined : n > 0 ? styles.pos : styles.neg);
const csvNum = (n: number | null, digits: number): string => (n === null ? '' : n.toFixed(digits));

function dataBar(value: number, max: number, cls: string | undefined): ReactNode {
  if (value <= 0 || max <= 0) return null;
  return <span className={cls} style={{ width: `${Math.max(4, Math.round((value / max) * 100))}%` }} aria-hidden />;
}

export const COLUMNS: ColumnDef[] = [
  // ── Results ────────────────────────────────────────────────────────────────
  {
    key: 'spend',
    label: 'Spend',
    group: 'results',
    info: 'Facebook ad spend in the selected period.',
    sort: (r) => r.spendUsd,
    cell: (r, ctx) => (
      <>
        {ctx && dataBar(r.spendUsd, ctx.maxSpend, styles.barSpend)}
        {formatUsd(r.spendUsd)}
      </>
    ),
    csv: (r) => r.spendUsd.toFixed(2),
  },
  {
    key: 'revenue',
    label: 'Revenue',
    group: 'results',
    info: 'AdSense for Search earnings attributed to the campaign (after any platform cut). Google reports earnings a few hours late, so a brand-new campaign looks worse than it is.',
    sort: (r) => r.revenueUsd,
    cell: (r, ctx) => (
      <>
        {ctx && dataBar(r.revenueUsd, ctx.maxRevenue, styles.barRevenue)}
        {formatUsd(r.revenueUsd)}
      </>
    ),
    csv: (r) => r.revenueUsd.toFixed(2),
  },
  {
    key: 'profit',
    label: 'Profit',
    group: 'results',
    info: 'Revenue − spend.',
    sort: (r) => r.profitUsd,
    cell: (r) => formatUsd(derive.profit(r)),
    csv: (r) => derive.profit(r).toFixed(2),
    tone: (r) => toneOf(derive.profit(r)),
  },
  {
    key: 'roi',
    label: 'ROI',
    group: 'results',
    info: 'Profit ÷ spend. Break-even is 0%.',
    sort: (r) => (r.spendUsd > 0 ? r.roi : null),
    cell: (r) => {
      const v = derive.roi(r);
      return v === null ? '—' : formatRoi(v);
    },
    csv: (r) => csvNum(derive.roi(r) === null ? null : derive.roi(r)! * 100, 1),
    tone: (r) => toneOf(derive.roi(r)),
  },
  // ── Per visit & per click (ClickFlare-named) ──────────────────────────────────
  {
    key: 'epv',
    label: 'EPV',
    group: 'unit',
    info: 'Earnings per visit = revenue ÷ visits. Same as ClickFlare EPV. Green when it beats CPC — each visit earns more than it costs.',
    sort: (r) => derive.epv(r),
    cell: (r) => formatUnitUsd(derive.epv(r)),
    csv: (r) => csvNum(derive.epv(r), 4),
    tone: (r) => {
      const e = derive.epv(r);
      const c = derive.cpc(r);
      return e === null || c === null ? undefined : e > c ? styles.pos : e < c ? styles.neg : undefined;
    },
  },
  {
    key: 'cpc',
    label: 'CPC',
    group: 'unit',
    info: 'Cost per visit = spend ÷ visits (Facebook link clicks). Same as ClickFlare CPV.',
    sort: (r) => derive.cpc(r),
    cell: (r) => formatUnitUsd(derive.cpc(r)),
    csv: (r) => csvNum(derive.cpc(r), 4),
  },
  {
    key: 'rpc',
    label: 'RPC',
    group: 'unit',
    info: "Revenue per ad click = revenue ÷ ad clicks. Same as ClickFlare's Dynamic payout (revenue ÷ conversions). Today's RPC climbs through the day as Google's earnings catch up with the clicks.",
    sort: (r) => derive.rpc(r),
    cell: (r) => formatUnitUsd(derive.rpc(r)),
    csv: (r) => csvNum(derive.rpc(r), 4),
  },
  {
    key: 'vcvr',
    label: 'vCVR',
    group: 'unit',
    info: 'Ad clicks ÷ visits — the share of visitors who clicked a Google ad. Same as ClickFlare vCVR.',
    sort: (r) => derive.vcvr(r),
    cell: (r) => formatRate(derive.vcvr(r)),
    csv: (r) => csvNum(derive.vcvr(r) === null ? null : derive.vcvr(r)! * 100, 2),
  },
  // ── Traffic ────────────────────────────────────────────────────────────────
  {
    key: 'visits',
    label: 'Visits',
    group: 'traffic',
    info: 'Facebook link clicks that reached the landing page. Same as ClickFlare Visits.',
    sort: (r) => r.clicks,
    cell: (r) => fmtCount(r.clicks),
    csv: (r) => String(r.clicks),
  },
  {
    key: 'adClicks',
    label: 'Ad clicks',
    group: 'traffic',
    info: "Visits that clicked a Google ad on the results page, counted live by our page — once per visit, the way ClickFlare counts Conversions. Google's own count runs higher (it counts every click, and a visitor can click more than one ad).",
    sort: (r) => r.adClicks,
    cell: (r) => fmtCount(r.adClicks),
    csv: (r) => String(r.adClicks),
  },
  {
    key: 'impressions',
    label: 'Impr',
    group: 'traffic',
    info: 'How many times Facebook showed the ads.',
    sort: (r) => r.impressions,
    cell: (r) => fmtCount(r.impressions),
    csv: (r) => String(r.impressions),
  },
  {
    key: 'ctr',
    label: 'CTR',
    group: 'traffic',
    info: 'Visits ÷ impressions — how often the ad was clicked when shown.',
    sort: (r) => derive.ctr(r),
    cell: (r) => formatRate(derive.ctr(r)),
    csv: (r) => csvNum(derive.ctr(r) === null ? null : derive.ctr(r)! * 100, 2),
  },
  // ── Facebook ───────────────────────────────────────────────────────────────
  {
    key: 'conv',
    label: 'Conv (FB)',
    group: 'facebook',
    info: "Facebook's count of the same ad-click event (the pixel 'Search' event) — what Facebook optimizes for. Usually below Ad clicks: Facebook can't match every visitor.",
    sort: (r) => r.conversions,
    cell: (r) => fmtCount(r.conversions),
    csv: (r) => String(r.conversions),
  },
  {
    key: 'cpa',
    label: 'CPA (FB)',
    group: 'facebook',
    info: 'Spend ÷ Conv (FB) — what Facebook reports each ad click cost.',
    sort: (r) => derive.cpa(r),
    cell: (r) => formatUnitUsd(derive.cpa(r)),
    csv: (r) => csvNum(derive.cpa(r), 4),
  },
  {
    key: 'cvrFb',
    label: 'CVR (FB)',
    group: 'facebook',
    info: 'Conv (FB) ÷ visits — the ad-click rate as Facebook sees it. Compare with vCVR.',
    sort: (r) => derive.cvrFb(r),
    cell: (r) => formatRate(derive.cvrFb(r)),
    csv: (r) => csvNum(derive.cvrFb(r) === null ? null : derive.cvrFb(r)! * 100, 2),
  },
  // ── Controls ───────────────────────────────────────────────────────────────
  {
    key: 'budget',
    label: 'Budget',
    group: 'controls',
    info: "The campaign's daily budget on Facebook. Click to edit — it goes live on Facebook without re-review.",
    cell: () => null, // rendered by the page (inline editor)
    csv: () => '',
  },
];

export const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

/** The default view: results + the four unit metrics that explain them, plus the budget control. */
export const ESSENTIAL_COLUMNS: ColKey[] = ['spend', 'revenue', 'profit', 'roi', 'epv', 'cpc', 'rpc', 'vcvr', 'budget'];
export const ALL_COLUMNS: ColKey[] = COLUMNS.map((c) => c.key);

export const COLUMN_PRESETS: { id: string; label: string; columns: ColKey[] }[] = [
  { id: 'essentials', label: 'Essentials', columns: ESSENTIAL_COLUMNS },
  { id: 'funnel', label: 'Funnel', columns: ['spend', 'revenue', 'roi', 'visits', 'cpc', 'vcvr', 'adClicks', 'rpc', 'epv', 'conv', 'cvrFb'] },
  { id: 'facebook', label: 'Facebook', columns: ['spend', 'impressions', 'ctr', 'visits', 'cpc', 'conv', 'cpa', 'budget'] },
  { id: 'all', label: 'All', columns: ALL_COLUMNS },
];
