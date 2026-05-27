import { describe, expect, it } from 'vitest';
import { allocateByWeights, applyRevenueCut, formatUsd } from './money.js';

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
