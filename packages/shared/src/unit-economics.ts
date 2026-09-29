import { AFS_CLICK_SUPPRESSION_THRESHOLD } from './constants.js';

/**
 * Unit economics for the Analytics workbench — named and defined exactly like ClickFlare so a buyer
 * comparing the two compares like with like:
 *
 *   EPV  = revenue ÷ visits          ClickFlare EPV. Our "visits" = Facebook link clicks.
 *   RPC  = revenue ÷ paid ad clicks   ClickFlare RPC (= revenue ÷ conversions; in search arbitrage a
 *                                     ClickFlare conversion is the monetized ad click).
 *   vCVR = paid ad clicks ÷ visits    ClickFlare vCVR.
 *   CPC  = spend ÷ visits             ClickFlare CPV.
 *
 * "Paid ad clicks" are Google-reported (AdSense for Search). Google HIDES a channel's click count on a
 * day with fewer than 10 ad clicks — it reports 0 clicks but still reports the earnings (2026-09:
 * 14% of revenue, 36% of earning campaign-days). Such a day is "masked": it's left out of RPC and vCVR
 * — numerator AND denominator — so both stay exact instead of inflating RPC / deflating vCVR.
 */

/** Google hid this channel-day's ad clicks: it earned, but reports fewer than 10 (i.e. 0) clicks. */
export function isMaskedAfsDay(afsClicks: number, revenueMinor: number): boolean {
  return revenueMinor > 0 && afsClicks < AFS_CLICK_SUPPRESSION_THRESHOLD;
}

/** Revenue per visit (ClickFlare EPV), or null with no visits. */
export function epv(revenueUsd: number, visits: number): number | null {
  return visits > 0 ? revenueUsd / visits : null;
}

/** Revenue per paid ad click (ClickFlare RPC), or null with no (visible) ad clicks. */
export function rpcPerAdClick(revenueUsd: number, adClicks: number): number | null {
  return adClicks > 0 ? revenueUsd / adClicks : null;
}

/** Paid ad clicks per visit as a fraction (ClickFlare vCVR), or null with no visits. */
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

export interface AdClickEconomics {
  /** Google-reported ad clicks on the days Google shows them. */
  adClicks: number;
  /** Buyer-visible revenue (after the platform cut) on those same days, USD. */
  adClickRevenueUsd: number;
  /** Visits (Facebook link clicks) on those same days — the vCVR denominator. */
  adClickVisits: number;
  /** Days that earned but whose ad clicks Google hid (left out of the three fields above). */
  maskedDays: number;
}

/**
 * Fold a campaign's per-channel AdSense rows + its per-day visits into the RPC/vCVR inputs. A day is
 * masked when ANY of its channels (an offers campaign has several) was masked — visits can't be split
 * per channel, so the whole day leaves both RPC and vCVR together and the ratios stay consistent.
 * Revenue is taken per channel-row after the buyer's cut, rounded to cents like everywhere else.
 */
export function adClickEconomics(input: {
  /**
   * Per-channel (or per-campaign rollup) AdSense rows. `forceMasked` marks a day masked from outside —
   * e.g. a rollup row whose day had a masked channel that the summed row can't reveal on its own.
   */
  channelDays: readonly { day: string; afsClicks: number; revenueUsdMinor: number; forceMasked?: boolean }[];
  visitsByDay: ReadonlyMap<string, number>;
  /** Platform revenue cut for this campaign's buyer (0..1). */
  cutPct: number;
}): AdClickEconomics {
  const byDay = new Map<string, { clicks: number; visibleMinor: number; masked: boolean }>();
  for (const r of input.channelDays) {
    const d = byDay.get(r.day) ?? { clicks: 0, visibleMinor: 0, masked: false };
    d.clicks += r.afsClicks;
    d.visibleMinor += Math.round(r.revenueUsdMinor * (1 - input.cutPct));
    d.masked = d.masked || Boolean(r.forceMasked) || isMaskedAfsDay(r.afsClicks, r.revenueUsdMinor);
    byDay.set(r.day, d);
  }
  let adClicks = 0;
  let visibleMinor = 0;
  let maskedDays = 0;
  const masked = new Set<string>();
  for (const [day, d] of byDay) {
    if (d.masked) {
      maskedDays += 1;
      masked.add(day);
      continue;
    }
    adClicks += d.clicks;
    visibleMinor += d.visibleMinor;
  }
  let adClickVisits = 0;
  for (const [day, v] of input.visitsByDay) if (!masked.has(day)) adClickVisits += v;
  return { adClicks, adClickRevenueUsd: Math.round(visibleMinor) / 100, adClickVisits, maskedDays };
}
