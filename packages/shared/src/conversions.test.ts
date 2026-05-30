import { describe, expect, it } from 'vitest';
import { buildFbc, pxeToCustomEventType, pxeToFbEvent } from './conversions.js';

describe('pxeToFbEvent', () => {
  it('maps each funnel stage to its standard Facebook event name', () => {
    expect(pxeToFbEvent('lander')).toBe('ViewContent');
    expect(pxeToFbEvent('search')).toBe('AddToCart');
    expect(pxeToFbEvent('adclick')).toBe('Search');
  });
  it('is case-insensitive and defaults to the main event (Search)', () => {
    expect(pxeToFbEvent('ADCLICK')).toBe('Search');
    expect(pxeToFbEvent(null)).toBe('Search');
    expect(pxeToFbEvent('unknown')).toBe('Search');
  });
});

describe('pxeToCustomEventType', () => {
  it('maps each funnel stage to the FB custom_event_type enum', () => {
    expect(pxeToCustomEventType('lander')).toBe('VIEW_CONTENT');
    expect(pxeToCustomEventType('search')).toBe('ADD_TO_CART');
    expect(pxeToCustomEventType('adclick')).toBe('SEARCH');
    expect(pxeToCustomEventType(null)).toBe('SEARCH');
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
