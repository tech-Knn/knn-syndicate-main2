import { describe, expect, it } from 'vitest';
import { type WhopLaunchAd, type WhopLaunchAdSet, type WhopLaunchCampaign, whopAdBody, whopAdGroupBody, whopCampaignBody, whopKeys } from './launch-map.js';

const campaign: WhopLaunchCampaign = { name: 'Senior SUV offers', objective: 'OUTCOME_LEADS', specialAdCategories: [], budgetMode: 'AD_SET', dailyBudgetCents: null };
const adSet: WhopLaunchAdSet = {
  name: 'US 35-65',
  dailyBudgetCents: 2500,
  countries: ['US', 'CA'],
  excludeCountries: [],
  ageMin: 35,
  ageMax: 65,
  genders: [],
  advantageAudience: false,
  placementMode: 'automatic',
  placements: [],
  languages: [],
  devicePlatforms: [],
  mobileOs: [],
  bidStrategy: null,
  costCapCents: null,
  startTime: null,
  endTime: null,
  pxeEvent: 'adclick',
};
const ad: WhopLaunchAd = { name: 'Ad A', headline: 'Compare SUV deals', primaryText: 'See what you qualify for.', description: null, cta: 'LEARN_MORE' };

describe('whopCampaignBody', () => {
  it('makes a Whop campaign from ours, budget on the ad group by default', () => {
    expect(whopCampaignBody(campaign, 'biz_AAAAAA1111', 'k1')).toEqual({ account_id: 'biz_AAAAAA1111', title: 'Senior SUV offers', platform: 'meta', objective: 'leads', idempotencyKey: 'k1' });
  });

  it('puts the budget on the campaign under campaign budget optimization, in USD', () => {
    const body = whopCampaignBody({ ...campaign, budgetMode: 'CAMPAIGN', dailyBudgetCents: 4250 }, 'biz_AAAAAA1111', 'k');
    expect(body).toMatchObject({ budget_optimization: 'ad_campaign', budget_amount: 42.5, budget_type: 'daily' });
  });

  it('maps objectives, defaulting to leads when we have no equivalent', () => {
    for (const [ours, theirs] of [['OUTCOME_LEADS', 'leads'], ['OUTCOME_SALES', 'sales'], ['OUTCOME_TRAFFIC', 'traffic'], ['OUTCOME_ENGAGEMENT', 'engagement'], ['OUTCOME_AWARENESS', 'awareness']] as const) {
      expect(whopCampaignBody({ ...campaign, objective: ours }, 'biz_AAAAAA1111', 'k').objective).toBe(theirs);
    }
  });

  it('maps special ad categories and merges the two that Whop calls financial_products', () => {
    const body = whopCampaignBody({ ...campaign, specialAdCategories: ['HOUSING', 'CREDIT', 'FINANCIAL_PRODUCTS_SERVICES', 'ISSUES_ELECTIONS_POLITICS', 'EMPLOYMENT'] }, 'biz_AAAAAA1111', 'k');
    expect(body.special_ad_categories).toEqual(['housing', 'financial_products', 'politics', 'employment']);
  });
});

describe('whopAdGroupBody', () => {
  it('optimizes for the money event on a website conversion, budget on the ad group under ABO', () => {
    expect(whopAdGroupBody(adSet, 'adcamp_X', 'AD_SET', 'k2')).toEqual({
      ad_campaign_id: 'adcamp_X',
      title: 'US 35-65',
      budget_amount: 25,
      budget_type: 'daily',
      conversion_location: 'website',
      conversion_event: 'submit_application',
      optimization_goal: 'conversions',
      regions: { include: { countries: ['US', 'CA'] } },
      demographics: { automatic: false, minimum_age: 35, maximum_age: 65, gender: 'all' },
      placements: 'automatic',
      idempotencyKey: 'k2',
    });
  });

  it('leaves the budget off the ad group when the campaign owns it', () => {
    expect(whopAdGroupBody(adSet, 'adcamp_X', 'CAMPAIGN', 'k')).not.toHaveProperty('budget_amount');
  });


  it('maps gender: one of the two is that gender, both or neither is everyone', () => {
    const g = (genders: string[]) => whopAdGroupBody({ ...adSet, genders }, 'c', 'AD_SET', 'k').demographics?.gender;
    expect([g([]), g(['male']), g(['female']), g(['male', 'female'])]).toEqual(['all', 'male', 'female', 'all']);
  });

  it('passes exclusions, languages, schedule and Advantage+ through', () => {
    const body = whopAdGroupBody(
      { ...adSet, excludeCountries: ['RU'], languages: ['en', 'es'], advantageAudience: true, startTime: new Date('2026-10-01T04:00:00Z'), endTime: new Date('2026-10-31T04:00:00Z') },
      'c',
      'AD_SET',
      'k',
    );
    expect(body.regions).toEqual({ include: { countries: ['US', 'CA'] }, exclude: { countries: ['RU'] } });
    expect(body.languages).toEqual(['en', 'es']);
    expect(body.demographics?.automatic).toBe(true);
    expect(body).toMatchObject({ starts_at: '2026-10-01T04:00:00.000Z', ends_at: '2026-10-31T04:00:00.000Z' });
  });

  it('groups manual placements by platform, in Whop\'s position names, dropping none silently', () => {
    const body = whopAdGroupBody({ ...adSet, placementMode: 'manual', placements: ['facebook_feed', 'facebook_reels', 'instagram_stream', 'instagram_search', 'audience_network_classic'] }, 'c', 'AD_SET', 'k');
    expect(body.placements).toEqual([
      { platform: 'facebook', positions: ['feed', 'facebook_reels'] },
      { platform: 'instagram', positions: ['stream', 'ig_search'] },
      { platform: 'audience_network', positions: ['classic'] },
    ]);
  });

  it('targets devices and operating systems', () => {
    expect(whopAdGroupBody({ ...adSet, devicePlatforms: ['mobile'], mobileOs: ['ios', 'android'] }, 'c', 'AD_SET', 'k').devices).toEqual({ platforms: ['mobile'], operating_systems: [{ os: 'ios' }, { os: 'android' }] });
    expect(whopAdGroupBody(adSet, 'c', 'AD_SET', 'k')).not.toHaveProperty('devices');
  });

  it('maps a cost cap to an average target and a bid cap to a maximum target', () => {
    expect(whopAdGroupBody({ ...adSet, bidStrategy: 'COST_CAP', costCapCents: 350 }, 'c', 'AD_SET', 'k')).toMatchObject({ bid_type: 'average_target', desired_cost_per_result: 3.5 });
    expect(whopAdGroupBody({ ...adSet, bidStrategy: 'LOWEST_COST_WITH_BID_CAP', costCapCents: 500 }, 'c', 'AD_SET', 'k')).toMatchObject({ bid_type: 'maximum_target', desired_cost_per_result: 5 });
    expect(whopAdGroupBody({ ...adSet, bidStrategy: 'LOWEST_COST_WITHOUT_CAP' }, 'c', 'AD_SET', 'k')).not.toHaveProperty('bid_type');
  });
});

describe('whopAdBody', () => {
  const ctx = { adGroupId: 'adgrp_X', url: 'https://go.example.test/go/abc123', fileId: 'file_X', pageId: 'sacc_X' };

  it('carries the copy, our go-link, the creative and the page', () => {
    expect(whopAdBody({ ...ad, description: 'Free quotes' }, ctx, 'k3')).toEqual({
      ad_group_id: 'adgrp_X',
      title: 'Ad A',
      url: 'https://go.example.test/go/abc123',
      headlines: [{ text: 'Compare SUV deals' }],
      primary_texts: [{ text: 'See what you qualify for.' }],
      descriptions: [{ text: 'Free quotes' }],
      call_to_action: 'learn_more',
      creatives: [{ id: 'file_X' }],
      social_accounts: [{ id: 'sacc_X' }],
      multi_advertiser_ads: false,
      idempotencyKey: 'k3',
    });
  });

  it('turns multi-advertiser ads OFF (Whop would default it to ON)', () => {
    expect(whopAdBody(ad, ctx, 'k')).toHaveProperty('multi_advertiser_ads', false);
  });

  it('never sets Whop\'s reserved click parameters itself', () => {
    const body = whopAdBody(ad, ctx, 'k');
    expect(body).not.toHaveProperty('url_parameters');
    expect(body.url).not.toMatch(/wacid|wasid|waid|utm_/);
  });

  it('leaves out what is not there yet (resume before the creative or page exists)', () => {
    const body = whopAdBody(ad, { ...ctx, fileId: null, pageId: null }, 'k');
    expect(body).not.toHaveProperty('creatives');
    expect(body).not.toHaveProperty('social_accounts');
  });

});

describe('whopKeys', () => {
  it('derives each replay key from our own row ids, so a retry never creates a second object', () => {
    expect(whopKeys.campaign('c1')).toBe('knn-camp-c1');
    expect(whopKeys.adGroup('s1')).toBe('knn-grp-s1');
    expect(whopKeys.ad('a1')).toBe('knn-ad-a1');
    expect(whopKeys.file('a1')).toBe('knn-file-a1');
  });

  it('gives a rebuilt tree new keys, so Whop cannot replay the one that was discarded', () => {
    expect(whopKeys.campaign('c1', 0)).toBe('knn-camp-c1'); // the first tree's keys carry no suffix
    expect(whopKeys.campaign('c1', 2)).toBe('knn-camp-c1-e2');
    expect(whopKeys.adGroup('s1', 1)).toBe('knn-grp-s1-e1');
    expect(whopKeys.ad('a1', 3)).toBe('knn-ad-a1-e3');
    expect(whopKeys.file('a1', 1)).toBe('knn-file-a1-e1');
    expect(new Set([0, 1, 2].map((e) => whopKeys.ad('a1', e))).size).toBe(3);
  });
});
