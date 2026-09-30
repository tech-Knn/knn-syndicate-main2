import { extractWhopClick as sharedExtract } from '@knn/shared';
import { describe, expect, it } from 'vitest';
import { extractWhopClick, hasWhopSignal, whopLandingUrl } from './whop-click.js';

const REAL =
  'wacid=adcamp_ARRzXWlc8gt&wasid=adgrp_adGTsobtDlzz&waid=ad_I2YRNtEkImoX5qB&utm_meta_ad_id=120215678901234567&utm_meta_adset_id=120215678901234566&utm_meta_campaign_id=120215678901234565&utm_source=fb&utm_placement=Facebook_Mobile_Feed&utm_medium=paid_social&utm_content=Ceramic%20coating%20reel&utm_adset=Austin%20SUV%20owners&utm_whop=true&fbclid=IwAR0example';

// Inputs both implementations must treat identically: real clicks, non-Whop traffic, and hostile values.
const VECTORS = [
  REAL,
  '',
  'fbclid=IwAR0x&utm_source=facebook',
  'utm_source=fb&utm_medium=paid_social',
  'utm_whop=true&utm_source=ig',
  'UTM_WHOP=TRUE',
  'wacid=adcamp_x&wasid=%3Cscript%3E&waid=ad_I2YRNtEkImoX5qB&utm_meta_ad_id=12ab&utm_whop=true',
  'wacid=%27%3B%20DROP&wasid=adgrp_&waid=ad_',
  `waid=ad_I2YRNtEkImoX5qB&utm_content=${'x'.repeat(5000)}&utm_adset=${'y'.repeat(5000)}&utm_source=${'z'.repeat(5000)}&utm_placement=${'p'.repeat(5000)}`,
  'wacid=adcamp_ARRzXWlc8gt&wacid=adcamp_OTHER123456',
  'waid=ad_I2YRNtEkImoX5qB&utm_source=%20%20',
  'waid=ad_I2YRNtEkImoX5qB&utm_content=%E2%9C%93%20unicode%20ok',
];

describe('whop-click (the Worker\'s own copy)', () => {
  it('agrees with the shared implementation on every input', () => {
    for (const v of VECTORS) {
      expect(extractWhopClick(new URLSearchParams(v)), v.slice(0, 80)).toEqual(sharedExtract(v));
    }
  });

  it('flags a Whop click exactly when the parser finds one', () => {
    for (const v of VECTORS) {
      const q = Object.fromEntries(new URLSearchParams(v));
      expect(hasWhopSignal(q), v.slice(0, 80)).toBe(extractWhopClick(new URLSearchParams(v)) !== null);
    }
  });

  it('reads a real Whop click', () => {
    expect(extractWhopClick(new URLSearchParams(REAL))).toMatchObject({ campaignId: 'adcamp_ARRzXWlc8gt', adGroupId: 'adgrp_adGTsobtDlzz', adId: 'ad_I2YRNtEkImoX5qB', utm: { source: 'fb', placement: 'Facebook_Mobile_Feed' } });
  });

  it('does not treat Facebook-only traffic as a Whop click', () => {
    expect(hasWhopSignal({ fbclid: 'IwAR0x', utm_source: 'facebook' })).toBe(false);
    expect(hasWhopSignal({})).toBe(false);
    expect(hasWhopSignal({ waid: '<script>' })).toBe(false);
  });
});

describe('whopLandingUrl', () => {
  it('keeps Whop\'s parameters and fbclid, in order, on the go-link path', () => {
    const url = whopLandingUrl(new URL(`https://go.example.test/go/abc123?${REAL}`));
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://go.example.test/go/abc123');
    expect(u.searchParams.get('waid')).toBe('ad_I2YRNtEkImoX5qB');
    expect(u.searchParams.get('fbclid')).toBe('IwAR0example');
    expect(u.searchParams.get('utm_content')).toBe('Ceramic coating reel');
  });

  it('drops our own routing params and anything a stranger appended', () => {
    const u = new URL(whopLandingUrl(new URL('https://go.example.test/go/abc123?waid=ad_I2YRNtEkImoX5qB&kaid=123&rc=secret&txid=t&evil=1&_ws=tok&fbclid=IwAR0x')));
    expect([...u.searchParams.keys()].sort()).toEqual(['fbclid', 'waid']);
  });

  it('drops a malformed Whop id instead of passing it on to Whop', () => {
    const u = new URL(whopLandingUrl(new URL('https://go.example.test/go/abc123?waid=%3Cscript%3E&wacid=adcamp_ARRzXWlc8gt&utm_meta_ad_id=12ab&fbclid=IwAR0x')));
    expect([...u.searchParams.keys()].sort()).toEqual(['fbclid', 'wacid']);
  });

  it('caps long values and omits the ? when nothing is kept', () => {
    const long = new URL(whopLandingUrl(new URL(`https://go.example.test/go/abc123?fbclid=${'x'.repeat(2000)}`)));
    expect(long.searchParams.get('fbclid')).toHaveLength(300);
    expect(whopLandingUrl(new URL('https://go.example.test/go/abc123?other=1'))).toBe('https://go.example.test/go/abc123');
  });
});
