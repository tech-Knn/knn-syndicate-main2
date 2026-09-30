import { describe, expect, it } from 'vitest';
import { FUNNEL_EVENT_NAME, FUNNEL_STAGES } from './conversions.js';
import { WHOP_EVENT_FOR_STAGE, WHOP_MAIN_CONVERSION_EVENT, WHOP_RESERVED_CLICK_PARAMS, extractWhopClick, whopEventForStoredName } from './whop.js';

describe('funnel → Whop events', () => {
  it('maps the three stages the way ClickFlare runs it live for Whop', () => {
    expect(WHOP_EVENT_FOR_STAGE).toEqual({ lander: 'view_content', search: 'add_to_cart', adclick: 'submit_application' });
    expect(WHOP_MAIN_CONVERSION_EVENT).toBe('submit_application');
  });

  it('maps every stored event name (Facebook\'s) back to a Whop event, and nothing else', () => {
    for (const stage of FUNNEL_STAGES) expect(whopEventForStoredName(FUNNEL_EVENT_NAME[stage])).toBe(WHOP_EVENT_FOR_STAGE[stage]);
    expect(whopEventForStoredName('Purchase')).toBeUndefined();
    expect(whopEventForStoredName('')).toBeUndefined();
  });
});

describe('extractWhopClick', () => {
  const real =
    'wacid=adcamp_ARRzXWlc8gt&wasid=adgrp_adGTsobtDlzz&waid=ad_I2YRNtEkImoX5qB&utm_meta_ad_id=120215678901234567&utm_meta_adset_id=120215678901234566&utm_meta_campaign_id=120215678901234565&utm_source=fb&utm_placement=Facebook_Mobile_Feed&utm_medium=paid_social&utm_content=Ceramic%20coating%20reel&utm_adset=Austin%20SUV%20owners&utm_whop=true&fbclid=IwAR0example';

  it('reads a real Whop ad click', () => {
    expect(extractWhopClick(real)).toEqual({
      campaignId: 'adcamp_ARRzXWlc8gt',
      adGroupId: 'adgrp_adGTsobtDlzz',
      adId: 'ad_I2YRNtEkImoX5qB',
      metaCampaignId: '120215678901234565',
      metaAdSetId: '120215678901234566',
      metaAdId: '120215678901234567',
      utm: { source: 'fb', medium: 'paid_social', content: 'Ceramic coating reel', adset: 'Austin SUV owners', placement: 'Facebook_Mobile_Feed' },
    });
  });

  it('accepts a leading ? and a URLSearchParams', () => {
    expect(extractWhopClick(`?${real}`)?.adId).toBe('ad_I2YRNtEkImoX5qB');
    expect(extractWhopClick(new URLSearchParams(real))?.adId).toBe('ad_I2YRNtEkImoX5qB');
  });

  it('is null for traffic that did not come from a Whop ad', () => {
    expect(extractWhopClick('')).toBeNull();
    expect(extractWhopClick('fbclid=IwAR0x&utm_source=facebook')).toBeNull();
    expect(extractWhopClick('utm_source=fb&utm_medium=paid_social')).toBeNull();
  });

  it('still recognises a Whop click that carries only the utm_whop flag', () => {
    expect(extractWhopClick('utm_whop=true&utm_source=ig')).toMatchObject({ campaignId: undefined, utm: { source: 'ig' } });
  });

  it('drops malformed ids instead of passing them on (they are stored, then sent back to Whop)', () => {
    const c = extractWhopClick('wacid=adcamp_x&wasid=%3Cscript%3E&waid=ad_I2YRNtEkImoX5qB&utm_meta_ad_id=12ab&utm_whop=true');
    expect(c).toMatchObject({ campaignId: undefined, adGroupId: undefined, adId: 'ad_I2YRNtEkImoX5qB', metaAdId: undefined });
    // Nothing valid and no flag: not a Whop click at all.
    expect(extractWhopClick('wacid=%27%3B%20DROP&wasid=adgrp_&waid=ad_')).toBeNull();
  });

  it('caps the length of free-text fields', () => {
    const long = 'x'.repeat(5000);
    const c = extractWhopClick(`waid=ad_I2YRNtEkImoX5qB&utm_content=${long}&utm_adset=${long}&utm_source=${long}&utm_placement=${long}`);
    expect(c?.utm.content).toHaveLength(200);
    expect(c?.utm.adset).toHaveLength(200);
    expect(c?.utm.source).toHaveLength(40);
    expect(c?.utm.placement).toHaveLength(60);
  });

  it('lists the parameters Whop reserves, which our own links must never reuse', () => {
    for (const p of ['wacid', 'wasid', 'waid', 'utm_whop', 'utm_source', 'utm_meta_ad_id']) expect(WHOP_RESERVED_CLICK_PARAMS).toContain(p);
  });
});
