import { describe, expect, it } from 'vitest';
import {
  type AdSignals,
  allocateByWeights,
  allocateCampaignRevenue,
  applyRevenueCut,
  chooseAllocationBasis,
  formatUsd,
  toUsdMinor,
} from './money.js';

describe('allocateByWeights (conversion-weighted revenue, D8)', () => {
  it('gives all revenue to the only converting ad', () => {
    // $50.00 campaign revenue, one ad with 1 conversion
    expect(allocateByWeights(5000, [1])).toEqual([5000]);
  });

  it('splits $50 evenly across 4 ads with 1 conversion each (the worked example)', () => {
    expect(allocateByWeights(5000, [1, 1, 1, 1])).toEqual([1250, 1250, 1250, 1250]);
  });

  it('uses largest-remainder so an uneven split still sums exactly to the total', () => {
    const parts = allocateByWeights(5000, [1, 2]);
    expect(parts).toEqual([1667, 3333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(5000);
  });

  it('returns zeros when there are no conversions (caller applies fallback)', () => {
    expect(allocateByWeights(5000, [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('always sums to the total for arbitrary weights', () => {
    const cases: Array<[number, number[]]> = [
      [9999, [3, 5, 7]],
      [12345, [1, 1, 1, 1, 1, 1, 1]],
      [100, [2, 0, 5, 0, 1]],
      [1, [1, 1, 1]],
    ];
    for (const [total, weights] of cases) {
      const parts = allocateByWeights(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe('applyRevenueCut', () => {
  it('splits gross into buyer-visible + platform margin (30% cut)', () => {
    expect(applyRevenueCut(10000, 0.3)).toEqual({ visibleCents: 7000, marginCents: 3000 });
  });

  it('clamps the cut into [0,1]', () => {
    expect(applyRevenueCut(10000, 2)).toEqual({ visibleCents: 0, marginCents: 10000 });
    expect(applyRevenueCut(10000, -1)).toEqual({ visibleCents: 10000, marginCents: 0 });
  });
});

describe('formatUsd', () => {
  it('formats dollars as USD', () => {
    expect(formatUsd(2615)).toBe('$2,615.00');
  });
});

const sig = (conversions: number, clicks: number, impressions: number): AdSignals => ({
  conversions,
  clicks,
  impressions,
});

describe('chooseAllocationBasis (D8 + zero-conversion fallback, OPEN_QUESTIONS #1)', () => {
  it('prefers conversions when any ad converted', () => {
    expect(chooseAllocationBasis([sig(0, 9, 99), sig(1, 0, 0)])).toBe('conversions');
  });
  it('falls back to clicks when there are no conversions', () => {
    expect(chooseAllocationBasis([sig(0, 3, 99), sig(0, 1, 99)])).toBe('clicks');
  });
  it('falls back to impressions when there are no conversions or clicks', () => {
    expect(chooseAllocationBasis([sig(0, 0, 50), sig(0, 0, 10)])).toBe('impressions');
  });
  it('is unallocated when every signal is zero', () => {
    expect(chooseAllocationBasis([sig(0, 0, 0), sig(0, 0, 0)])).toBe('unallocated');
  });
});

describe('allocateCampaignRevenue (campaign gross → per-ad shares)', () => {
  it('worked example: $50 → one ad with 1 conversion gets all $50', () => {
    const { basis, allocations } = allocateCampaignRevenue(5000, [sig(1, 5, 100), sig(0, 9, 200)]);
    expect(basis).toBe('conversions');
    expect(allocations).toEqual([5000, 0]);
  });

  it('worked example: $50 → four ads with 1 conversion each get $12.50 each', () => {
    const { basis, allocations } = allocateCampaignRevenue(5000, [sig(1, 0, 0), sig(1, 0, 0), sig(1, 0, 0), sig(1, 0, 0)]);
    expect(basis).toBe('conversions');
    expect(allocations).toEqual([1250, 1250, 1250, 1250]);
  });

  it('splits by clicks when no conversions, summing exactly to the gross', () => {
    const { basis, allocations } = allocateCampaignRevenue(5000, [sig(0, 3, 0), sig(0, 1, 0)]);
    expect(basis).toBe('clicks');
    expect(allocations).toEqual([3750, 1250]);
    expect(allocations.reduce((a, b) => a + b, 0)).toBe(5000);
  });

  it('splits by impressions when no conversions or clicks', () => {
    const { basis, allocations } = allocateCampaignRevenue(900, [sig(0, 0, 2), sig(0, 0, 1)]);
    expect(basis).toBe('impressions');
    expect(allocations).toEqual([600, 300]);
  });

  it('holds revenue unallocated (all zeros) when there is no signal at all', () => {
    const { basis, allocations } = allocateCampaignRevenue(5000, [sig(0, 0, 0), sig(0, 0, 0)]);
    expect(basis).toBe('unallocated');
    expect(allocations).toEqual([0, 0]);
    // The gross stays at the campaign level (unallocated = gross − Σ allocations).
    expect(5000 - allocations.reduce((a, b) => a + b, 0)).toBe(5000);
  });
});

describe('toUsdMinor (D15 native → USD conversion)', () => {
  it('multiplies native minor units by USD-per-unit rate, rounding to a cent', () => {
    // €100.00 (10000 minor) at 1.08 USD/EUR → $108.00
    expect(toUsdMinor(10000, 1.08)).toBe(10800);
    // ₹1000.00 (100000 paise) at 0.012 USD/INR → $12.00
    expect(toUsdMinor(100000, 0.012)).toBe(1200);
  });
  it('treats USD→USD (rate 1) as identity', () => {
    expect(toUsdMinor(4242, 1)).toBe(4242);
  });
  it('returns 0 for a missing/invalid rate (caller should backfill FX)', () => {
    expect(toUsdMinor(10000, 0)).toBe(0);
    expect(toUsdMinor(10000, Number.NaN)).toBe(0);
  });
});
