/**
 * Money + revenue-allocation helpers.
 *
 * Amounts are handled in integer minor units (cents) for exact arithmetic.
 * The allocator (DECISION D8) splits a campaign's revenue across its ads in
 * proportion to each ad's conversions, using the largest-remainder method so
 * the parts sum EXACTLY to the total (no lost/created cents).
 */

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

export function formatUsd(dollars: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(dollars);
}

/**
 * Render a true-ROI fraction (profit ÷ spend, e.g. 0.2) as a signed percentage: 0.2 → "20%",
 * -0.2 → "-20%", 0 → "0%", 1.3333 → "133.3%". Break-even is 0%. Used everywhere ROI is shown.
 */
export function formatRoi(roi: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
    // Show an explicit sign (+20% / -20%, 0% at break-even) so profit/loss never relies on
    // color alone (WCAG 1.4.1 — use-of-color). The sign is the primary cue; red/green reinforces.
    signDisplay: 'exceptZero',
  }).format(roi);
}

/**
 * Compact USD for dashboard KPI tiles where space is tight ($1.2M, $48.3K).
 * Below $10k it falls back to the full formatting (no information lost on small
 * numbers); keep the full value in a `title`/tooltip for the exact figure.
 */
export function formatUsdCompact(dollars: number): string {
  if (Math.abs(dollars) < 10_000) return formatUsd(dollars);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(dollars);
}

/**
 * Split `totalCents` across buckets by integer/float `weights` (e.g. per-ad
 * conversions). Largest-remainder rounding guarantees the result sums to
 * `totalCents`. If all weights are <= 0, returns all zeros — the caller applies
 * the zero-conversion fallback (OPEN_QUESTIONS #1).
 */
export function allocateByWeights(totalCents: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const total = Math.round(totalCents);
  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = safe.reduce((a, b) => a + b, 0);
  if (sum <= 0) return new Array(n).fill(0) as number[];

  const ideal = safe.map((w) => (total * w) / sum);
  const result = ideal.map((x) => Math.floor(x));
  let remainder = total - result.reduce((a, b) => a + b, 0);

  const order = ideal
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);

  for (let k = 0; k < order.length && remainder > 0; k++) {
    const entry = order[k];
    if (!entry) break;
    result[entry.i] = (result[entry.i] ?? 0) + 1;
    remainder -= 1;
  }
  return result;
}

/**
 * Apply the platform revenue cut (DECISION: revenue shown to buyer =
 * gross x (1 - cut)). Returns the buyer-visible amount and the platform margin.
 * `cutPct` is a fraction in [0, 1].
 */
export function applyRevenueCut(
  grossCents: number,
  cutPct: number,
): { visibleCents: number; marginCents: number } {
  const clamped = Math.min(Math.max(cutPct, 0), 1);
  const marginCents = Math.round(grossCents * clamped);
  return { visibleCents: grossCents - marginCents, marginCents };
}

/** What drove a campaign→ad revenue split (DECISION D8 + OPEN_QUESTIONS #1 fallback). */
export type AllocationBasis = 'conversions' | 'clicks' | 'impressions' | 'unallocated';

/** Per-ad signals used to weight a campaign's revenue split. */
export interface AdSignals {
  conversions: number;
  clicks: number;
  impressions: number;
}

/**
 * Pick the weighting basis for splitting a campaign's revenue across its ads
 * (DECISION D8: by FB conversion share). Zero-conversion fallback
 * (OPEN_QUESTIONS #1): if Σ conversions = 0 → split by clicks; if Σ clicks = 0 →
 * by impressions; if all are 0 → `unallocated` (hold at the campaign level,
 * admin-visible — no ad gets the revenue).
 */
export function chooseAllocationBasis(ads: AdSignals[]): AllocationBasis {
  const sum = (key: keyof AdSignals): number => ads.reduce((a, x) => a + (x[key] || 0), 0);
  if (sum('conversions') > 0) return 'conversions';
  if (sum('clicks') > 0) return 'clicks';
  if (sum('impressions') > 0) return 'impressions';
  return 'unallocated';
}

/**
 * Split a campaign's gross revenue (USD minor units) across its ads by conversion
 * share (D8), applying the zero-conversion fallback chain (OPEN_QUESTIONS #1). The
 * split uses largest-remainder so the parts sum EXACTLY to `grossCents` (unless the
 * basis is `unallocated`, where every ad gets 0 and the whole amount stays unallocated
 * at the campaign level). Order of `ads` is preserved in `allocations`.
 */
export function allocateCampaignRevenue(
  grossCents: number,
  ads: AdSignals[],
): { basis: AllocationBasis; allocations: number[] } {
  const basis = chooseAllocationBasis(ads);
  if (basis === 'unallocated') {
    return { basis, allocations: new Array(ads.length).fill(0) as number[] };
  }
  const weights = ads.map((a) => a[basis]);
  return { basis, allocations: allocateByWeights(grossCents, weights) };
}

/**
 * Convert a native minor-unit amount to USD minor units using `rate` = USD per 1
 * unit of the native currency (D15). USD→USD uses rate 1. Minor units scale linearly,
 * so multiply directly and round to the nearest USD cent.
 */
export function toUsdMinor(nativeMinor: number, rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round(nativeMinor * rate);
}
