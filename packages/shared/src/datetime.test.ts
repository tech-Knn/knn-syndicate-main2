import { describe, expect, it } from 'vitest';
import {
  businessDay,
  businessDayBoundsUtc,
  sharesBusinessClock,
  timeZoneOffsetMs,
  zonedInstantUtc,
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

describe('zonedInstantUtc', () => {
  it('places a wall-clock hour at its real instant', () => {
    expect(zonedInstantUtc('2026-09-30', 12, 'America/Los_Angeles').toISOString()).toBe('2026-09-30T19:00:00.000Z'); // PDT, UTC-7
    expect(zonedInstantUtc('2026-12-15', 12, 'America/Los_Angeles').toISOString()).toBe('2026-12-15T20:00:00.000Z'); // PST, UTC-8
    expect(zonedInstantUtc('2026-09-30', 0, 'Asia/Kolkata').toISOString()).toBe('2026-09-29T18:30:00.000Z');
    expect(zonedInstantUtc('2026-09-30', 9, 'Asia/Tokyo').toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('is right on the days the clocks change, before and after the switch', () => {
    // US spring forward 2026-03-08 02:00 -> 03:00 (Los Angeles): 01:00 is PST (UTC-8), 04:00 is PDT (UTC-7).
    expect(zonedInstantUtc('2026-03-08', 1, 'America/Los_Angeles').toISOString()).toBe('2026-03-08T09:00:00.000Z');
    expect(zonedInstantUtc('2026-03-08', 4, 'America/Los_Angeles').toISOString()).toBe('2026-03-08T11:00:00.000Z');
    // US fall back 2026-11-01 02:00 -> 01:00: 00:00 is PDT (UTC-7), 03:00 is PST (UTC-8).
    expect(zonedInstantUtc('2026-11-01', 0, 'America/Los_Angeles').toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(zonedInstantUtc('2026-11-01', 3, 'America/Los_Angeles').toISOString()).toBe('2026-11-01T11:00:00.000Z');
  });
});

describe('sharesBusinessClock', () => {
  it('is true for IST and its alias, false for any other offset or an unknown zone', () => {
    expect(sharesBusinessClock('Asia/Kolkata')).toBe(true);
    expect(sharesBusinessClock('Asia/Calcutta')).toBe(true);
    expect(sharesBusinessClock('Asia/Kathmandu')).toBe(false); // +5:45
    expect(sharesBusinessClock('Asia/Karachi')).toBe(false);
    expect(sharesBusinessClock('America/New_York')).toBe(false);
    expect(sharesBusinessClock('Europe/London')).toBe(false);
    expect(sharesBusinessClock('Not/AZone')).toBe(false);
  });
});
