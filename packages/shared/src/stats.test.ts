import { describe, expect, it } from 'vitest';
import { RSOC_FILL_DISPLAY_FLOOR, coverage, displayFillRate } from './stats.js';

describe('coverage (RSOC fill rate = matched / requests)', () => {
  it('is the matched/requests ratio', () => {
    expect(coverage(720, 900)).toBeCloseTo(0.8, 5);
    expect(coverage(0, 100)).toBe(0); // requests but nothing matched → genuinely 0% fill
    expect(coverage(50, 50)).toBe(1);
  });
  it('is 0 (not NaN) when there were no requests', () => {
    expect(coverage(0, 0)).toBe(0);
    expect(coverage(5, 0)).toBe(0);
  });
});

describe('displayFillRate (floor-aware)', () => {
  it('returns null below the significance floor (too small a sample to trust)', () => {
    expect(displayFillRate(0, RSOC_FILL_DISPLAY_FLOOR - 1)).toBeNull();
    expect(displayFillRate(3, 5)).toBeNull();
  });
  it('returns the coverage ratio at/above the floor', () => {
    expect(displayFillRate(0, RSOC_FILL_DISPLAY_FLOOR)).toBe(0); // ≥floor + 0 matched = real 0% fill
    expect(displayFillRate(80, 100)).toBeCloseTo(0.8, 5);
  });
});
