import { describe, expect, it } from 'vitest';
import { DEFAULT_AFS_STYLE_ID, RESULTS_MAX_ADS, RESULTS_ORGANIC_COUNT, RSOC_CHIPS_PER_UNIT, RSOC_UNITS } from './csa';

describe('reference layout constants (D40)', () => {
  it('uses the reference style, two units of six chips', () => {
    expect(DEFAULT_AFS_STYLE_ID).toBe('8472563621');
    expect(RSOC_UNITS).toBe(2);
    expect(RSOC_CHIPS_PER_UNIT).toBe(6);
  });

  it('never asks for more ads than there are organic results (Google: ads ≤ results)', () => {
    expect(RESULTS_MAX_ADS).toBe(1);
    expect(RESULTS_ORGANIC_COUNT).toBe(1);
    expect(RESULTS_MAX_ADS).toBeLessThanOrEqual(RESULTS_ORGANIC_COUNT);
  });
});
