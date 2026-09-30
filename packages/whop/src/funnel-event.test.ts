import { describe, expect, it } from 'vitest';
import { WHOP_EVENT_MAX_AGE_MS, buildWhopEvent, whopEventTooOld } from './funnel-event.js';

const base = {
  bizId: 'biz_AAAAAA1111',
  clickId: '7d4f6a1e-0000-4000-8000-000000000001',
  occurredAt: new Date('2026-09-30T10:15:30.000Z'),
  landingUrl: 'https://go.example.test/go/abc123?wacid=adcamp_ARRzXWlc8gt&wasid=adgrp_adGTsobtDlzz&waid=ad_I2YRNtEkImoX5qB&fbclid=IwAR0x',
  ipAddress: '203.0.113.9',
  userAgent: 'Mozilla/5.0 (iPhone)',
  fbclid: 'IwAR0x',
  fbc: 'fb.1.1790000000000.IwAR0x',
  fbp: 'fb.1.1790000000000.1234567890',
  click: {
    campaignId: 'adcamp_ARRzXWlc8gt',
    adGroupId: 'adgrp_adGTsobtDlzz',
    adId: 'ad_I2YRNtEkImoX5qB',
    utm: { source: 'fb', medium: 'paid_social', content: 'Reel A', adset: 'Austin', placement: 'Facebook_Mobile_Feed' },
  },
} as const;

describe('buildWhopEvent', () => {
  it('reports each funnel stage as the Whop event ClickFlare maps it to', () => {
    expect(buildWhopEvent({ ...base, storedEventName: 'ViewContent' })?.event_name).toBe('view_content');
    expect(buildWhopEvent({ ...base, storedEventName: 'AddToCart' })?.event_name).toBe('add_to_cart');
    expect(buildWhopEvent({ ...base, storedEventName: 'Search' })?.event_name).toBe('submit_application');
  });

  it('carries everything Whop resolves the ad from', () => {
    expect(buildWhopEvent({ ...base, storedEventName: 'Search' })).toEqual({
      account_id: 'biz_AAAAAA1111',
      event_name: 'submit_application',
      event_id: '7d4f6a1e-0000-4000-8000-000000000001',
      event_time: '2026-09-30T10:15:30.000Z',
      action_source: 'website',
      url: base.landingUrl,
      context: {
        ad_campaign_id: 'adcamp_ARRzXWlc8gt',
        ad_set_id: 'adgrp_adGTsobtDlzz',
        ad_id: 'ad_I2YRNtEkImoX5qB',
        fbclid: 'IwAR0x',
        fbc: 'fb.1.1790000000000.IwAR0x',
        fbp: 'fb.1.1790000000000.1234567890',
        ip_address: '203.0.113.9',
        user_agent: 'Mozilla/5.0 (iPhone)',
        utm_source: 'fb',
        utm_medium: 'paid_social',
        utm_content: 'Reel A',
      },
      user: { external_id: '7d4f6a1e-0000-4000-8000-000000000001' },
    });
  });

  it('uses the click id as the event id, so a repeat is one event for Whop', () => {
    const a = buildWhopEvent({ ...base, storedEventName: 'ViewContent' })!;
    const b = buildWhopEvent({ ...base, storedEventName: 'ViewContent' })!;
    expect(a.event_id).toBe(b.event_id);
    // Whop dedupes per event NAME + id, so the three stages of one visit do not collide.
    expect(buildWhopEvent({ ...base, storedEventName: 'AddToCart' })!.event_id).toBe(a.event_id);
  });

  it('leaves out what it does not have instead of sending nulls', () => {
    const ev = buildWhopEvent({ bizId: base.bizId, storedEventName: 'ViewContent', clickId: base.clickId, occurredAt: base.occurredAt })!;
    expect(ev).toEqual({ account_id: base.bizId, event_name: 'view_content', event_id: base.clickId, event_time: base.occurredAt.toISOString(), action_source: 'website', user: { external_id: base.clickId } });
    expect(JSON.stringify(ev)).not.toContain('null');
  });

  it('sends a value only when there is one, with a lowercase currency', () => {
    expect(buildWhopEvent({ ...base, storedEventName: 'Search', valueMinor: 125, currency: 'USD' })).toMatchObject({ value: 1.25, currency: 'usd' });
    expect(buildWhopEvent({ ...base, storedEventName: 'Search', valueMinor: 0 })).not.toHaveProperty('value');
    expect(buildWhopEvent({ ...base, storedEventName: 'Search', valueMinor: null })).not.toHaveProperty('currency');
  });

  it('refuses a stored name that is not a funnel event', () => {
    expect(buildWhopEvent({ ...base, storedEventName: 'Purchase' })).toBeNull();
    expect(buildWhopEvent({ ...base, storedEventName: '' })).toBeNull();
  });
});

describe('whopEventTooOld', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  it('stops a day before Whop\'s 28-day limit', () => {
    expect(WHOP_EVENT_MAX_AGE_MS).toBe(27 * 86_400_000);
    expect(whopEventTooOld(new Date(now.getTime() - 26 * 86_400_000), now)).toBe(false);
    expect(whopEventTooOld(new Date(now.getTime() - 27 * 86_400_000 - 1), now)).toBe(true);
    expect(whopEventTooOld(now, now)).toBe(false);
  });
});
