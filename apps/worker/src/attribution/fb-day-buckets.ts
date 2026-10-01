import type { FbAdInsightRow } from '@knn/fb';
import { DEFAULT_BUSINESS_TZ, businessDay, zonedInstantUtc } from '@knn/shared';

/**
 * Facebook labels each insights day in the AD ACCOUNT's reporting timezone, but everything else on the platform (AdSense
 * revenue, channel holders, Whop spend, the dashboards) keys on the IST business day (D4). For an account that is not on
 * IST clocks the labels disagree: a Los Angeles account's "Sept 30" is 12:30 IST Sept 30 to 12:30 IST Oct 1, so its spend
 * would be set against the wrong day's revenue. This turns Facebook's HOURLY rows (each one an hour on the account's
 * clock) into IST-day rows: every hour is placed at its real instant and credited to the IST day that instant falls in.
 */

/** The hour (0-23) of Facebook's hourly bucket label, e.g. "14:00:00 - 14:59:59". `null` when it is not in that shape. */
export function hourOfBucketLabel(label: string | undefined): number | null {
  const m = /^(\d{1,2}):/.exec(label ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

export interface RebucketResult {
  rows: FbAdInsightRow[];
  /** Hourly rows whose bucket label could not be read, so they could not be placed. */
  skipped: number;
}

/**
 * Sum hourly rows (`dimValue` = Facebook's hour bucket, `day` = the ACCOUNT's date) into one row per (ad, business day), keeping
 * only business days inside [since, until]. The caller asks Facebook for a wider range (one account-day either side), so
 * the days at the edge of the window are complete; the partial days beyond it are dropped here.
 */
export function rebucketHourlyToBusinessDays(
  hourly: readonly FbAdInsightRow[],
  accountTz: string,
  window: { since: string; until: string },
  businessTz: string = DEFAULT_BUSINESS_TZ,
): RebucketResult {
  const out = new Map<string, FbAdInsightRow>();
  let skipped = 0;
  for (const r of hourly) {
    const hour = hourOfBucketLabel(r.dimValue);
    if (hour === null) {
      skipped += 1;
      continue;
    }
    const day = businessDay(zonedInstantUtc(r.day, hour, accountTz), businessTz);
    if (day < window.since || day > window.until) continue;
    const key = `${r.fbAdId}|${day}`;
    const acc = out.get(key);
    if (acc) {
      acc.impressions += r.impressions;
      acc.clicks += r.clicks;
      acc.conversions += r.conversions;
      acc.spendMinor += r.spendMinor;
    } else {
      out.set(key, { fbAdId: r.fbAdId, day, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, spendMinor: r.spendMinor });
    }
  }
  return { rows: [...out.values()], skipped };
}
