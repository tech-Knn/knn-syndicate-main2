import { describe, expect, it } from 'vitest';
import type { FbAdInsightRow } from '@knn/fb';
import { hourOfBucketLabel, rebucketHourlyToBusinessDays } from './fb-day-buckets.js';

const label = (h: number): string => `${String(h).padStart(2, '0')}:00:00 - ${String(h).padStart(2, '0')}:59:59`;
const hourRow = (day: string, hour: number, spendMinor: number, extra: Partial<FbAdInsightRow> = {}): FbAdInsightRow => ({
  fbAdId: 'ad1', day, impressions: 10, clicks: 1, conversions: 1, spendMinor, dimValue: label(hour), ...extra,
});
const spendByDay = (rows: FbAdInsightRow[], ad = 'ad1'): Record<string, number> =>
  Object.fromEntries(rows.filter((r) => r.fbAdId === ad).map((r) => [r.day, r.spendMinor]));

describe('hourOfBucketLabel', () => {
  it('reads the hour from Facebook\'s bucket label and refuses anything else', () => {
    expect(hourOfBucketLabel('00:00:00 - 00:59:59')).toBe(0);
    expect(hourOfBucketLabel('14:00:00 - 14:59:59')).toBe(14);
    expect(hourOfBucketLabel('23:00:00 - 23:59:59')).toBe(23);
    expect(hourOfBucketLabel('24:00:00')).toBeNull();
    expect(hourOfBucketLabel('unknown')).toBeNull();
    expect(hourOfBucketLabel(undefined)).toBeNull();
  });
});

describe('rebucketHourlyToBusinessDays (an ad account that is not on IST clocks)', () => {
  const win = { since: '2026-09-30', until: '2026-09-30' };

  it('Los Angeles (PDT, UTC-7): an IST day is made of the account\'s hours 12:00 of one day to 11:59 of the next', () => {
    // IST Sept 30 = 18:30 UTC Sept 29 .. 18:30 UTC Sept 30 = LA Sept 29 11:30 .. Sept 30 11:30.
    const rows = [
      hourRow('2026-09-29', 10, 1), // 17:00 UTC Sept 29 = 22:30 IST Sept 29 -> IST Sept 29: dropped (outside the window)
      hourRow('2026-09-29', 11, 10), // 18:00 UTC = 23:30 IST Sept 29: dropped
      hourRow('2026-09-29', 12, 100), // 19:00 UTC = 00:30 IST Sept 30: IN
      hourRow('2026-09-29', 23, 1000), // 06:00 UTC Sept 30 = 11:30 IST: IN
      hourRow('2026-09-30', 0, 10000), // 07:00 UTC = 12:30 IST: IN
      hourRow('2026-09-30', 11, 100000), // 18:00 UTC = 23:30 IST Sept 30: IN
      hourRow('2026-09-30', 12, 1000000), // 19:00 UTC = 00:30 IST Oct 1: dropped
    ];
    const r = rebucketHourlyToBusinessDays(rows, 'America/Los_Angeles', win);
    expect(spendByDay(r.rows)).toEqual({ '2026-09-30': 100 + 1000 + 10000 + 100000 });
    expect(r.skipped).toBe(0);
  });

  it('Shanghai (UTC+8, ahead of IST): the account\'s 02:30-IST-equivalent hours belong to the PREVIOUS IST day', () => {
    // Shanghai 2026-09-30 02:00 = 18:00 UTC Sept 29 = 23:30 IST Sept 29 (previous IST day);
    // Shanghai 2026-09-30 03:00 = 19:00 UTC Sept 29 = 00:30 IST Sept 30.
    const rows = [hourRow('2026-09-30', 2, 7), hourRow('2026-09-30', 3, 11), hourRow('2026-10-01', 2, 13)];
    const r = rebucketHourlyToBusinessDays(rows, 'Asia/Shanghai', { since: '2026-09-29', until: '2026-09-30' });
    expect(spendByDay(r.rows)).toEqual({ '2026-09-29': 7, '2026-09-30': 11 + 13 });
  });

  it('sums every metric, keeps ads apart and keeps the days apart', () => {
    const rows = [
      hourRow('2026-09-30', 0, 5, { impressions: 100, clicks: 4, conversions: 2 }),
      hourRow('2026-09-30', 1, 6, { impressions: 200, clicks: 5, conversions: 3 }),
      hourRow('2026-09-30', 1, 9, { fbAdId: 'ad2', impressions: 7, clicks: 1, conversions: 0 }),
      hourRow('2026-10-01', 1, 4), // LA Oct 1 01:00 = 08:00 UTC = 13:30 IST Oct 1
    ];
    const r = rebucketHourlyToBusinessDays(rows, 'America/Los_Angeles', { since: '2026-09-30', until: '2026-10-01' });
    const ad1 = r.rows.find((x) => x.fbAdId === 'ad1' && x.day === '2026-09-30')!;
    expect(ad1).toMatchObject({ impressions: 300, clicks: 9, conversions: 5, spendMinor: 11 });
    expect(r.rows.find((x) => x.fbAdId === 'ad2')).toMatchObject({ day: '2026-09-30', spendMinor: 9 });
    expect(spendByDay(r.rows)).toEqual({ '2026-09-30': 11, '2026-10-01': 4 });
    expect(r.rows.every((x) => x.dimValue === undefined)).toBe(true); // a daily row, not an hourly one
  });

  it('conserves spend: every hour is counted in exactly one IST day (nothing lost or doubled), across a clock change', () => {
    // A whole week of account hours around the US fall-back (2026-11-01), every hour 1 minor unit.
    const rows: FbAdInsightRow[] = [];
    for (let d = 28; d <= 31; d++) for (let h = 0; h < 24; h++) rows.push(hourRow(`2026-10-${d}`, h, 1));
    for (let d = 1; d <= 4; d++) for (let h = 0; h < 24; h++) rows.push(hourRow(`2026-11-0${d}`, h, 1));
    const r = rebucketHourlyToBusinessDays(rows, 'America/New_York', { since: '2000-01-01', until: '2100-01-01' });
    expect(r.rows.reduce((n, x) => n + x.spendMinor, 0)).toBe(rows.length);
    const days = Object.keys(spendByDay(r.rows)).sort();
    expect(days.length).toBeGreaterThanOrEqual(8);
  });

  it('counts the hours it cannot read as skipped instead of guessing a day', () => {
    const r = rebucketHourlyToBusinessDays(
      [hourRow('2026-09-30', 3, 5), hourRow('2026-09-30', 4, 9, { dimValue: 'garbled' }), hourRow('2026-09-30', 5, 2, { dimValue: undefined })],
      'America/Los_Angeles',
      win,
    );
    expect(r.skipped).toBe(2);
    expect(spendByDay(r.rows)).toEqual({ '2026-09-30': 5 });
  });
});
