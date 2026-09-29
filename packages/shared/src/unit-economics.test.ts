import { describe, expect, it } from 'vitest';
import {
  adClickEconomics,
  costPer,
  epv,
  formatRate,
  formatUnitUsd,
  isMaskedAfsDay,
  perVisit,
  rpcPerAdClick,
  vcvr,
} from './unit-economics.js';

describe('ClickFlare-named unit metrics', () => {
  it('EPV / RPC / vCVR / CPC match their definitions and are null without a denominator', () => {
    expect(epv(150, 13_500)).toBeCloseTo(0.0111, 4); // revenue ÷ visits
    expect(rpcPerAdClick(150, 3_165)).toBeCloseTo(0.0474, 4); // revenue ÷ paid ad clicks
    expect(vcvr(3_165, 13_500)).toBeCloseTo(0.2344, 4); // paid ad clicks ÷ visits
    expect(costPer(170, 13_500)).toBeCloseTo(0.0126, 4); // CPC = spend ÷ visits
    expect(perVisit(2_414, 13_500)).toBeCloseTo(0.1788, 4);
    expect([epv(1, 0), rpcPerAdClick(1, 0), vcvr(1, 0), costPer(1, 0), perVisit(1, 0)]).toEqual([null, null, null, null, null]);
  });

  it('formats sub-dollar unit prices with 3 decimals so they stay distinguishable', () => {
    expect(formatUnitUsd(0.0111)).toBe('$0.011');
    expect(formatUnitUsd(0.0474)).toBe('$0.047');
    expect(formatUnitUsd(1.5)).toBe('$1.50');
    expect(formatUnitUsd(0)).toBe('$0.00');
    expect(formatUnitUsd(null)).toBe('—');
  });

  it('formats rates with 1 decimal, 2 below 1%', () => {
    expect(formatRate(0.2344)).toBe('23.4%');
    expect(formatRate(0.0085)).toBe('0.85%');
    expect(formatRate(0)).toBe('0.0%');
    expect(formatRate(null)).toBe('—');
  });
});

describe('masked AdSense days (Google hides < 10 ad clicks/day)', () => {
  it('a day is masked only when it earned but shows fewer than 10 ad clicks', () => {
    expect(isMaskedAfsDay(0, 120)).toBe(true);
    expect(isMaskedAfsDay(9, 120)).toBe(true);
    expect(isMaskedAfsDay(10, 120)).toBe(false);
    expect(isMaskedAfsDay(0, 0)).toBe(false); // nothing earned → genuinely no clicks
  });

  it('leaves masked days out of RPC and vCVR on both sides of the ratio', () => {
    const visitsByDay = new Map([
      ['2026-09-27', 400],
      ['2026-09-28', 300], // masked below
      ['2026-09-29', 100], // no AdSense row: counts as 0 ad clicks
    ]);
    const r = adClickEconomics({
      channelDays: [
        { day: '2026-09-27', afsClicks: 90, revenueUsdMinor: 450 },
        { day: '2026-09-28', afsClicks: 0, revenueUsdMinor: 300 }, // earned $3, clicks hidden
      ],
      visitsByDay,
      cutPct: 0,
    });
    expect(r).toEqual({ adClicks: 90, adClickRevenueUsd: 4.5, adClickVisits: 500, maskedDays: 1 });
    // RPC $0.05 (not $0.083 from counting the masked $3 over 90 clicks); vCVR 18% over 500 visits.
    expect(rpcPerAdClick(r.adClickRevenueUsd, r.adClicks)).toBeCloseTo(0.05, 4);
    expect(vcvr(r.adClicks, r.adClickVisits)).toBeCloseTo(0.18, 4);
  });

  it('one masked channel masks the whole day of an offers campaign (visits can’t be split per channel)', () => {
    const r = adClickEconomics({
      channelDays: [
        { day: 'd1', afsClicks: 50, revenueUsdMinor: 500 },
        { day: 'd1', afsClicks: 0, revenueUsdMinor: 80 }, // second website's channel, hidden
        { day: 'd2', afsClicks: 20, revenueUsdMinor: 100 },
        { day: 'd2', afsClicks: 15, revenueUsdMinor: 90 },
      ],
      visitsByDay: new Map([
        ['d1', 1000],
        ['d2', 200],
      ]),
      cutPct: 0,
    });
    expect(r).toEqual({ adClicks: 35, adClickRevenueUsd: 1.9, adClickVisits: 200, maskedDays: 1 });
  });

  it('a rollup row can be force-masked when a channel inside it was masked', () => {
    const r = adClickEconomics({
      channelDays: [
        { day: 'd1', afsClicks: 50, revenueUsdMinor: 580, forceMasked: true }, // sum hides the masked channel
        { day: 'd2', afsClicks: 35, revenueUsdMinor: 190 },
      ],
      visitsByDay: new Map([
        ['d1', 1000],
        ['d2', 200],
      ]),
      cutPct: 0,
    });
    expect(r).toEqual({ adClicks: 35, adClickRevenueUsd: 1.9, adClickVisits: 200, maskedDays: 1 });
  });

  it('applies the buyer revenue cut per channel row', () => {
    const r = adClickEconomics({
      channelDays: [{ day: 'd1', afsClicks: 40, revenueUsdMinor: 1000 }],
      visitsByDay: new Map([['d1', 100]]),
      cutPct: 0.3,
    });
    expect(r.adClickRevenueUsd).toBe(7);
  });
});
