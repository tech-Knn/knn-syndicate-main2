/**
 * Unit economics for the Analytics workbench — named and defined exactly like ClickFlare so a buyer
 * comparing the two compares like with like:
 *
 *   EPV  = revenue ÷ visits          ClickFlare EPV. Our "visits" = Facebook link clicks.
 *   RPC  = revenue ÷ ad clicks       ClickFlare "Dynamic payout" (its RPC) = revenue ÷ conversions.
 *   vCVR = ad clicks ÷ visits        ClickFlare vCVR (visitCvr).
 *   CPC  = spend ÷ visits            ClickFlare CPV.
 *
 * "Ad clicks" are OUR OWN tracking (D30): the results page records a visit's Google ad click (the
 * funnel's `adclick` stage), at most once per visit — exactly how ClickFlare counts a conversion
 * (checked against its API 2026-09-30: dynamicPayout = revenue ÷ conversions, and no visit carries
 * more than one). So the count is live and never hidden. Google's own AdSense click count is not
 * used: it reports 0 on any channel-day with fewer than 10 clicks, which blanked RPC/vCVR on small
 * campaigns. Every click our page detects matches Google's count (101–117% of it on staging); the
 * once-per-visit count is ~72% of Google's, because a visitor who clicks averages ~1.4 ads — so RPC
 * reads ~1.4× Google's revenue-per-click, just as ClickFlare's does.
 */

/** Revenue per visit (ClickFlare EPV), or null with no visits. */
export function epv(revenueUsd: number, visits: number): number | null {
  return visits > 0 ? revenueUsd / visits : null;
}

/** Revenue per ad click (ClickFlare Dynamic payout / RPC), or null with no ad clicks. */
export function rpcPerAdClick(revenueUsd: number, adClicks: number): number | null {
  return adClicks > 0 ? revenueUsd / adClicks : null;
}

/** Ad clicks per visit as a fraction (ClickFlare vCVR), or null with no visits. */
export function vcvr(adClicks: number, visits: number): number | null {
  return visits > 0 ? adClicks / visits : null;
}

/** A count per visit (e.g. Facebook-reported conversions ÷ visits), or null with no visits. */
export function perVisit(count: number, visits: number): number | null {
  return visits > 0 ? count / visits : null;
}

/** Cost per unit (CPC = spend ÷ visits, CPA = spend ÷ conversions), or null when the unit count is 0. */
export function costPer(spendUsd: number, units: number): number | null {
  return units > 0 ? spendUsd / units : null;
}

/**
 * Unit-price USD. Sub-dollar amounts get 3 decimals ($0.011) — at 2 decimals EPV/RPC/CPC collapse to
 * "$0.01" and two very different campaigns look identical. Null → "—".
 */
export function formatUnitUsd(dollars: number | null): string {
  if (dollars === null || !Number.isFinite(dollars)) return '—';
  const digits = Math.abs(dollars) < 1 && dollars !== 0 ? 3 : 2;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(dollars);
}

/** A fraction as a percentage: 1 decimal, or 2 below 1% (CTR 0.85%). Null → "—". */
export function formatRate(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return '—';
  const pct = fraction * 100;
  return `${pct.toFixed(Math.abs(pct) < 1 && pct !== 0 ? 2 : 1)}%`;
}
