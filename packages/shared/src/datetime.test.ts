import { describe, expect, it } from 'vitest';
import {
  businessDay,
  businessDayBoundsUtc,
  timeZoneOffsetMs,
  zonedStartOfDayUtc,
} from './datetime.js';

const IST = 'Asia/Kolkata';

describe('businessDay (IST)', () => {
  it('rolls into the next IST day after 18:30 UTC', () => {
    // 20:00 UTC -> 01:30 IST next day
    expect(businessDay(new Date('2026-05-26T20:00:00Z'), IST)).toBe('2026-05-27');
  });

  it('stays on the same IST day before 18:30 UTC', () => {
    // 18:00 UTC -> 23:30 IST same day
    expect(businessDay(new Date('2026-05-26T18:00:00Z'), IST)).toBe('2026-05-26');
  });

  it('handles the exact IST midnight boundary (18:30 UTC)', () => {
    expect(businessDay(new Date('2026-05-26T18:30:00Z'), IST)).toBe('2026-05-27');
  });
});

describe('timeZoneOffsetMs', () => {
  it('reports +5:30 for IST (no DST)', () => {
    const off = timeZoneOffsetMs(new Date('2026-05-26T12:00:00Z'), IST);
    expect(off).toBe(5.5 * 60 * 60 * 1000);
  });
});

describe('zonedStartOfDayUtc (IST)', () => {
  it('maps the start of an IST day to 18:30 UTC the previous day', () => {
    expect(zonedStartOfDayUtc('2026-05-27', IST).toISOString()).toBe('2026-05-26T18:30:00.000Z');
  });
});

describe('businessDayBoundsUtc (IST)', () => {
  it('returns a 24h [start, end) window aligned to IST midnight', () => {
    const { start, end } = businessDayBoundsUtc('2026-05-27', IST);
    expect(start.toISOString()).toBe('2026-05-26T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-05-27T18:30:00.000Z');
  });
});
