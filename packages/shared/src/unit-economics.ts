/**
 * Unit economics for the Analytics workbench — computed exactly like ClickFlare (D30) so a buyer
 * comparing the two compares like with like. Every count is OUR OWN funnel tracking, each stage at
 * most once per visit, live and never hidden:
 *
 *   Visits          landed on the page            ClickFlare Visits
 *   Keyword clicks  clicked a keyword on it       ClickFlare Clicks
 *   Ad clicks       clicked a Google ad           ClickFlare Conversions
 *
 *   EPV  = revenue ÷ visits              ClickFlare EPV
 *   CPV  = spend ÷ visits                ClickFlare CPV
 *   RPC  = revenue ÷ ad clicks           ClickFlare Dynamic payout (its RPC)
 *   vCVR = ad clicks ÷ visits            ClickFlare vCVR — landing page → conversion
 *   CTR  = keyword clicks ÷ visits       ClickFlare CTR
 *   CVR  = ad clicks ÷ keyword clicks    ClickFlare CVR       (vCVR = CTR × CVR)
 *
 * Checked against ClickFlare's API (2026-09-30): dynamicPayout = revenue ÷ conversions and visitCvr =
 * conversions ÷ visits, to the cent; no visit carries more than one conversion.
 *
 * Why not Google's or Facebook's counts: Google reports 0 ad clicks on any channel-day with fewer
 * than 10, which blanked RPC/vCVR on small campaigns; and ~11% of Facebook link clicks never load
 * the page, so a Facebook-click "visit" isn't a landing. Our detection is complete — every ad click
 * the page sees comes to 101–117% of Google's reported clicks — but it counts once per visit, and a
 * visitor who clicks averages ~1.4 ads, so RPC reads ~1.4× Google's revenue-per-click, exactly as
 * ClickFlare's Dynamic payout does.
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

/** Keyword clicks per visit as a fraction (ClickFlare CTR), or null with no visits. */
export function lpCtr(keywordClicks: number, visits: number): number | null {
  return visits > 0 ? keywordClicks / visits : null;
}

/** Ad clicks per keyword click as a fraction (ClickFlare CVR), or null with no keyword clicks. */
export function cvr(adClicks: number, keywordClicks: number): number | null {
  return keywordClicks > 0 ? adClicks / keywordClicks : null;
}

/** A count per visit (e.g. Facebook-reported conversions ÷ visits), or null with no visits. */
export function perVisit(count: number, visits: number): number | null {
  return visits > 0 ? count / visits : null;
}

/** Cost per unit (CPV = spend ÷ visits, CPA = spend ÷ conversions), or null when the unit count is 0. */
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
