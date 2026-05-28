import { describe, expect, it } from 'vitest';
import { buildFbc, pxeToFbEvent } from './conversions.js';

describe('pxeToFbEvent', () => {
  it('maps the ad-set pxe to the standard Facebook event name', () => {
    expect(pxeToFbEvent('search')).toBe('Search');
    expect(pxeToFbEvent('lander')).toBe('ViewContent');
    expect(pxeToFbEvent('adclick')).toBe('Lead');
  });
  it('is case-insensitive and defaults to Search', () => {
    expect(pxeToFbEvent('SEARCH')).toBe('Search');
    expect(pxeToFbEvent(null)).toBe('Search');
    expect(pxeToFbEvent('unknown')).toBe('Search');
  });
});

describe('buildFbc', () => {
  it('builds the fb.1.<ms>.<fbclid> click identifier', () => {
    expect(buildFbc('AbC123', 1779950000000)).toBe('fb.1.1779950000000.AbC123');
  });
  it('returns undefined without an fbclid', () => {
    expect(buildFbc(undefined, 1779950000000)).toBeUndefined();
    expect(buildFbc('', 1779950000000)).toBeUndefined();
  });
});
