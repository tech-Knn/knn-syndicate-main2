import { formatUsd, formatUsdCompact } from '@knn/shared';
import type { Campaign, CampaignAdSet } from '@/lib/types';

/** A finite number or 0: a figure the API sent as null or NaN must never print as "NaN%" or "$NaN". */
export const safe = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** Whole numbers with thousands separators. A figure the API sent as null or NaN reads as 0. */
export const count = (n: number): string => new Intl.NumberFormat('en-US').format(safe(n));

/**
 * Money for a tile or a table cell. Exact to the cent up to a million dollars; from there "$22.2M", so one extreme
 * campaign never wraps a figure mid-digit or pushes a column out of view. Put the exact amount in a tooltip.
 */
export const money = (n: number): string => (Math.abs(safe(n)) >= 1_000_000 ? formatUsdCompact(safe(n)) : formatUsd(safe(n)));

/** A count, exact up to ten million, then "222.2M". */
export const bigCount = (n: number): string =>
  Math.abs(safe(n)) >= 10_000_000 ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(safe(n)) : count(n);

/**
 * A moment in the ad set's own timezone ("1 Oct, 14:30 IST"). An unknown timezone name throws in Intl, which would
 * white-screen the page, so it falls back to the business timezone, then UTC.
 */
export function formatWhen(iso: string, tz?: string | null): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'an unknown time';
  for (const zone of [tz, 'Asia/Kolkata', 'UTC']) {
    if (!zone) continue;
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(t);
    } catch {
      /* not a timezone name this browser knows: try the next */
    }
  }
  return new Date(t).toISOString();
}

export function scheduleText(set: Pick<CampaignAdSet, 'startTime' | 'endTime' | 'timezone'>): string {
  if (!set.startTime && !set.endTime) return 'Runs until paused';
  const from = set.startTime ? formatWhen(set.startTime, set.timezone) : 'now';
  const to = set.endTime ? formatWhen(set.endTime, set.timezone) : 'until paused';
  return `${from} to ${to}`;
}

/** The campaign's total daily budget in cents (the campaign's own for CBO, the sum of its ad sets for ABO). */
export function totalBudgetCents(c: Pick<Campaign, 'budgetMode' | 'dailyBudgetCents' | 'adSets'>): number {
  if (c.budgetMode === 'CAMPAIGN') return safe(c.dailyBudgetCents);
  return (c.adSets ?? []).reduce((n, s) => n + safe(s.dailyBudgetCents), 0);
}

/** "$25.00 a day", or "Not set" when there is no budget to speak of. */
export function budgetText(c: Pick<Campaign, 'budgetMode' | 'dailyBudgetCents' | 'adSets'>): string {
  const cents = totalBudgetCents(c);
  return cents > 0 ? `$${(cents / 100).toFixed(2)} a day` : 'Not set';
}

/** A launch that has not written anything for this long is stuck, not slow. (The Whop worker settles one at 15 min.) */
export const STUCK_LAUNCH_MS = 15 * 60_000;
export function launchStuck(c: Pick<Campaign, 'status' | 'updatedAt'>, now: number = Date.now()): boolean {
  if (c.status !== 'LAUNCHING') return false;
  const t = Date.parse(c.updatedAt);
  return Number.isFinite(t) && now - t > STUCK_LAUNCH_MS;
}

/** The words to show when a rejection arrives with no reason we can read. */
export const NO_REASON_TEXT =
  'No reason came back with it. Open the ads in the ad network’s own dashboard to read the review note, fix it there, then clone this campaign and launch the copy.';
