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
