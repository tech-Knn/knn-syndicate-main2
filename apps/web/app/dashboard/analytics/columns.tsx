import type { ReactNode } from 'react';
import {
  type CampaignPerf,
  type FunnelCounts,
  costPer,
  cvr,
  epv,
  formatRate,
  formatRoi,
  formatUnitUsd,
  formatUsd,
  lpCtr,
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
export interface MetricInputs extends FunnelCounts {
  spendUsd: number;
  revenueUsd: number;
  impressions: number;
  /** Facebook's link clicks (its own count). */
  clicks: number;
  /** Facebook-reported conversions (the pixel `Search` event = an ad click). */
  conversions: number;
}

const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

export const derive = {
  profit: (r: MetricInputs): number => r.revenueUsd - r.spendUsd,
  roi: (r: MetricInputs): number | null => (r.spendUsd > 0 ? (r.revenueUsd - r.spendUsd) / r.spendUsd : null),
  // Unit economics on our own funnel — computed exactly like ClickFlare (see unit-economics.ts).
  epv: (r: MetricInputs): number | null => epv(r.revenueUsd, r.visits),
  cpv: (r: MetricInputs): number | null => costPer(r.spendUsd, r.visits),
  rpc: (r: MetricInputs): number | null => rpcPerAdClick(r.revenueUsd, r.adClicks),
  vcvr: (r: MetricInputs): number | null => vcvr(r.adClicks, r.visits),
  ctr: (r: MetricInputs): number | null => lpCtr(r.keywordClicks, r.visits),
  cvr: (r: MetricInputs): number | null => cvr(r.adClicks, r.keywordClicks),
  // Facebook's side.
  landRate: (r: MetricInputs): number | null => ratio(r.visits, r.clicks),
  ctrFb: (r: MetricInputs): number | null => ratio(r.clicks, r.impressions),
  cpcFb: (r: MetricInputs): number | null => costPer(r.spendUsd, r.clicks),
  cpa: (r: MetricInputs): number | null => costPer(r.spendUsd, r.conversions),
  cvrFb: (r: MetricInputs): number | null => ratio(r.conversions, r.clicks),
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
  const t: MetricInputs = { spendUsd: 0, revenueUsd: 0, impressions: 0, clicks: 0, conversions: 0, visits: 0, keywordClicks: 0, adClicks: 0 };
  for (const r of rows) {
    t.spendUsd += r.spendUsd;
    t.revenueUsd += r.revenueUsd;
    t.impressions += r.impressions;
    t.clicks += r.clicks;
    t.conversions += r.conversions;
    t.visits += r.visits;
    t.keywordClicks += r.keywordClicks;
    t.adClicks += r.adClicks;
  }
  return t;
}

/**
 * Columns that come from the ad network are labelled by source (D32): "(FB)" for Facebook rows, "(Whop)" for Whop rows,
 * "(FB/Whop)" when the rows in view are a mix, so a buyer never reads Whop's numbers under a "Facebook" heading. The
 * registry below keeps its Facebook wording (one definition per metric); this relabels it at render time, and leaves
 * the text untouched when every row is Facebook, which is how it always read.
 */
export type NetworkTag = 'FB' | 'Whop' | 'FB/Whop';

export function networkTag(providers: Iterable<'FACEBOOK' | 'WHOP'>): NetworkTag {
  const seen = new Set(providers);
  if (seen.has('WHOP') && seen.has('FACEBOOK')) return 'FB/Whop';
  return seen.has('WHOP') ? 'Whop' : 'FB';
}

export function relabel(text: string, tag: NetworkTag): string {
  if (tag === 'FB') return text;
  const word = tag === 'Whop' ? 'Whop' : 'Facebook/Whop';
  return text.replace(/\bFB\b/g, tag).replace(/\bFacebook\b/g, word);
}

/**
 * Where the Facebook wording, merely relabelled, would say something FALSE about Whop rows, the text is written out per
 * network. A Whop ad's "conversions" are OUR OWN recorded ad clicks (Whop's own count only on a day we recorded none), not the
 * ad network's count of its pixel event, and revenue is weighed by them; "clicked the ad on Whop" is not where Meta shows it.
 * Keyed by column key; the ads / countries / hours breakdown uses the same keys (`detail:revenue` is its own, because the main
 * table's Revenue column says something else).
 */
const NETWORK_TEXT: Record<string, { whop: string; mixed: string }> = {
  conv: {
    whop: "The ad clicks we recorded for the ad (the same event as Ad clicks; Whop's own count only on a day we recorded none). Revenue is split across a campaign's ads by it.",
    mixed: "Facebook rows: Facebook's count of the same ad-click event (its pixel 'Search' event). Whop rows: the ad clicks we recorded (Whop's own count only on a day we recorded none).",
  },
  cpa: {
    whop: 'Spend ÷ Conv (Whop) — what each recorded ad click cost.',
    mixed: "Spend ÷ Conv — what each ad click cost (Facebook's count for Facebook rows, ours for Whop rows).",
  },
  cvrFb: {
    whop: 'Conv (Whop) ÷ Whop clicks — recorded ad clicks per link click.',
    mixed: "Conv ÷ link clicks — the ad-click rate (Facebook's count for Facebook rows, ours for Whop rows).",
  },
  fbClicks: {
    whop: "Whop's link clicks — people who clicked the ad.",
    mixed: "Link clicks reported by the ad network (Facebook's or Whop's) — people who clicked the ad.",
  },
  'detail:revenue': {
    whop: "Estimated — Google reports revenue per campaign, so it is split by each ad's recorded ad clicks.",
    mixed: "Estimated — Google reports revenue per campaign, so it is split by ad clicks (Facebook's count for Facebook ads, our recorded count for Whop ads).",
  },
  'group:facebook': {
    whop: "Whop's own numbers: its impressions, link clicks and cost per click, plus the ad clicks we recorded per ad.",
    mixed: "The ad network's own numbers (Facebook's or Whop's): impressions, link clicks and cost per click, plus each network's conversion count.",
  },
};

/** A column's (or group's) description for the rows in view: written out per network where relabelling would be false, else relabelled. */
export function infoFor(key: string, info: string, tag: NetworkTag): string {
  if (tag === 'FB') return info;
  return NETWORK_TEXT[key]?.[tag === 'Whop' ? 'whop' : 'mixed'] ?? relabel(info, tag);
}

export type GroupKey = 'results' | 'unit' | 'traffic' | 'facebook' | 'controls';

export const GROUPS: Record<GroupKey, { label: string; info: string }> = {
  results: { label: 'Results', info: 'What the campaign spent and earned in the selected period.' },
  unit: {
    label: 'Per visit & per click',
    info: 'Unit economics, computed exactly like ClickFlare. A campaign makes money when EPV (earned per visit) beats CPV (paid per visit).',
  },
  traffic: {
    label: 'Funnel',
    info: 'Our own tracking, once per visit and live: visits → keyword clicks → ad clicks. The same counts ClickFlare shows as Visits → Clicks → Conversions.',
  },
  facebook: { label: 'Facebook', info: "Facebook's own numbers: its clicks, its cost per click and its pixel conversions (what it optimizes for)." },
  controls: { label: '', info: '' },
};

export type ColKey =
  | 'spend'
  | 'revenue'
  | 'profit'
  | 'roi'
  | 'epv'
  | 'cpv'
  | 'rpc'
  | 'vcvr'
  | 'visits'
  | 'keywordClicks'
  | 'ctr'
  | 'adClicks'
  | 'cvr'
  | 'impressions'
  | 'fbClicks'
  | 'ctrFb'
  | 'cpcFb'
  | 'landRate'
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
const csvPct = (n: number | null): string => csvNum(n === null ? null : n * 100, 2);

function dataBar(value: number, max: number, cls: string | undefined): ReactNode {
  if (value <= 0 || max <= 0) return null;
  return <span className={cls} style={{ width: `${Math.max(4, Math.round((value / max) * 100))}%` }} aria-hidden />;
}

/** A count column (sortable, compact, exact in CSV). */
function countCol(key: ColKey, label: string, group: GroupKey, info: string, get: (r: MetricInputs) => number): ColumnDef {
  return { key, label, group, info, sort: get, cell: (r) => fmtCount(get(r)), csv: (r) => String(get(r)) };
}

/** A rate column (a fraction shown as a %). */
function rateCol(key: ColKey, label: string, group: GroupKey, info: string, get: (r: MetricInputs) => number | null): ColumnDef {
  return { key, label, group, info, sort: get, cell: (r) => formatRate(get(r)), csv: (r) => csvPct(get(r)) };
}

/** A unit-price column (USD per visit / click). */
function unitCol(key: ColKey, label: string, group: GroupKey, info: string, get: (r: MetricInputs) => number | null): ColumnDef {
  return { key, label, group, info, sort: get, cell: (r) => formatUnitUsd(get(r)), csv: (r) => csvNum(get(r), 4) };
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
  // ── Per visit & per click (computed exactly like ClickFlare) ─────────────────
  {
    ...unitCol('epv', 'EPV', 'unit', 'Earnings per visit = revenue ÷ visits. Same as ClickFlare EPV. Green when it beats CPV — each visit earns more than it costs.', derive.epv),
    tone: (r) => {
      const e = derive.epv(r);
      const c = derive.cpv(r);
      return e === null || c === null ? undefined : e > c ? styles.pos : e < c ? styles.neg : undefined;
    },
  },
  unitCol('cpv', 'CPV', 'unit', 'Cost per visit = spend ÷ visits. Same as ClickFlare CPV.', derive.cpv),
  unitCol(
    'rpc',
    'RPC',
    'unit',
    "Revenue per ad click = revenue ÷ ad clicks. Same as ClickFlare's Dynamic payout (revenue ÷ conversions). Today's RPC climbs through the day as Google's earnings catch up with the clicks.",
    derive.rpc,
  ),
  rateCol(
    'vcvr',
    'vCVR',
    'unit',
    'Ad clicks ÷ visits — the landing page → conversion rate: the share of visitors who clicked a Google ad. Same as ClickFlare vCVR (conversions ÷ visits).',
    derive.vcvr,
  ),
  // ── Funnel (our own tracking, once per visit) ─────────────────────────────────
  countCol(
    'visits',
    'Visits',
    'traffic',
    'People who landed on the page — counted by our page, once per visit, live. Same as ClickFlare Visits. Below FB clicks: some people leave before the page loads.',
    (r) => r.visits,
  ),
  countCol(
    'keywordClicks',
    'Keyword clicks',
    'traffic',
    'Visits that clicked a keyword on the page and reached the results page (once per visit). ClickFlare: Clicks.',
    (r) => r.keywordClicks,
  ),
  rateCol(
    'ctr',
    'CTR',
    'traffic',
    'Keyword clicks ÷ visits — how many visitors clicked a keyword. Same as ClickFlare CTR. Low CTR usually means Google hid or weakened the keyword block: check the rc and the keywords.',
    derive.ctr,
  ),
  countCol(
    'adClicks',
    'Ad clicks',
    'traffic',
    "Visits that clicked a Google ad on the results page (once per visit). ClickFlare: Conversions. Google's own count runs higher — it counts every click, and a visitor can click more than one ad.",
    (r) => r.adClicks,
  ),
  rateCol(
    'cvr',
    'CVR',
    'traffic',
    'Ad clicks ÷ keyword clicks — of the visitors who searched, how many clicked an ad. Same as ClickFlare CVR. Low CVR usually means the keywords bring weak ads. vCVR = CTR × CVR.',
    derive.cvr,
  ),
  // ── Facebook ───────────────────────────────────────────────────────────────
  countCol('impressions', 'Impr', 'facebook', 'How many times Facebook showed the ads.', (r) => r.impressions),
  countCol('fbClicks', 'FB clicks', 'facebook', "Facebook's link clicks — people who clicked the ad on Facebook.", (r) => r.clicks),
  rateCol('ctrFb', 'CTR (FB)', 'facebook', 'FB clicks ÷ impressions — how often people clicked the ad when Facebook showed it.', derive.ctrFb),
  unitCol('cpcFb', 'CPC (FB)', 'facebook', "Spend ÷ FB clicks — Facebook's cost per link click.", derive.cpcFb),
  rateCol(
    'landRate',
    'Land rate',
    'facebook',
    "Visits ÷ FB clicks — how many Facebook clicks actually loaded the page. The rest left before it loaded (slow page, redirect) or were sent to the safe page. Today's value can run ahead while Facebook catches up on its clicks.",
    derive.landRate,
  ),
  countCol(
    'conv',
    'Conv (FB)',
    'facebook',
    "Facebook's count of the same ad-click event (the pixel 'Search' event) — what Facebook optimizes for. Usually below Ad clicks: Facebook can't match every visitor.",
    (r) => r.conversions,
  ),
  unitCol('cpa', 'CPA (FB)', 'facebook', 'Spend ÷ Conv (FB) — what Facebook reports each ad click cost.', derive.cpa),
  rateCol('cvrFb', 'CVR (FB)', 'facebook', 'Conv (FB) ÷ FB clicks — the ad-click rate as Facebook sees it.', derive.cvrFb),
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
export const ESSENTIAL_COLUMNS: ColKey[] = ['spend', 'revenue', 'profit', 'roi', 'epv', 'cpv', 'rpc', 'vcvr', 'budget'];
export const ALL_COLUMNS: ColKey[] = COLUMNS.map((c) => c.key);

export const COLUMN_PRESETS: { id: string; label: string; columns: ColKey[] }[] = [
  { id: 'essentials', label: 'Essentials', columns: ESSENTIAL_COLUMNS },
  { id: 'funnel', label: 'Funnel', columns: ['spend', 'revenue', 'roi', 'epv', 'rpc', 'vcvr', 'visits', 'keywordClicks', 'ctr', 'adClicks', 'cvr'] },
  { id: 'facebook', label: 'Facebook', columns: ['spend', 'impressions', 'fbClicks', 'ctrFb', 'cpcFb', 'landRate', 'conv', 'cpa', 'cvrFb', 'budget'] },
  { id: 'all', label: 'All', columns: ALL_COLUMNS },
];
