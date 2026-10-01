import { describe, expect, it } from 'vitest';
import { campaignDraftSchema, campaignSubmitIssues } from './campaigns.js';
import { AD_PROVIDERS, hasProviderCampaign, isAdProvider, isLaunched } from './providers.js';

const CONN = '55555555-5555-5555-5555-555555555555';
const UPLOAD = '66666666-6666-6666-6666-666666666666';

describe('isLaunched / hasProviderCampaign', () => {
  it('treats a Facebook campaign as launched once it has a Facebook campaign id (unchanged behaviour)', () => {
    expect(isLaunched({ adProvider: 'FACEBOOK', fbCampaignId: '123' })).toBe(true);
    expect(isLaunched({ adProvider: 'FACEBOOK', fbCampaignId: null })).toBe(false);
    // A row with no provider at all is a legacy Facebook row.
    expect(isLaunched({ fbCampaignId: '123' })).toBe(true);
    expect(isLaunched({})).toBe(false);
  });

  it('does not read a Whop campaign\'s missing Facebook id as "not launched"', () => {
    expect(isLaunched({ adProvider: 'WHOP', fbCampaignId: null, whopCampaignId: 'adcamp_X', status: 'ACTIVE' })).toBe(true);
    expect(isLaunched({ adProvider: 'WHOP', whopCampaignId: 'adcamp_X', status: 'PAUSED' })).toBe(true);
    expect(isLaunched({ adProvider: 'WHOP', whopCampaignId: 'adcamp_X', status: 'META_REJECTED' })).toBe(true);
  });

  it('keeps a Whop draft that failed its launch gates "not launched", though it exists at Whop', () => {
    for (const status of ['PROCESSING', 'LAUNCHING', 'BATCHED', 'DRAFT']) {
      const c = { adProvider: 'WHOP', whopCampaignId: 'adcamp_X', status };
      expect(isLaunched(c), status).toBe(false);
      expect(hasProviderCampaign(c), status).toBe(true);
    }
    expect(isLaunched({ adProvider: 'WHOP', whopCampaignId: null, status: 'ACTIVE' })).toBe(false);
  });

  it('never lets a Whop id make a Facebook campaign look launched, or the reverse', () => {
    expect(isLaunched({ adProvider: 'FACEBOOK', whopCampaignId: 'adcamp_X', fbCampaignId: null, status: 'ACTIVE' })).toBe(false);
    expect(isLaunched({ adProvider: 'WHOP', fbCampaignId: '123', whopCampaignId: null, status: 'ACTIVE' })).toBe(false);
  });

  it('knows the two providers', () => {
    expect(AD_PROVIDERS).toEqual(['FACEBOOK', 'WHOP']);
    expect(isAdProvider('WHOP')).toBe(true);
    expect(isAdProvider('whop')).toBe(false);
    expect(isAdProvider(undefined)).toBe(false);
  });
});

describe('the draft schema is backward compatible', () => {
  it('defaults to Facebook, so every existing draft, preset and clone still validates', () => {
    expect(campaignDraftSchema.parse({ name: 'Old draft' }).adProvider).toBe('FACEBOOK');
    expect(campaignDraftSchema.parse({ name: 'Old draft', adAccountId: '11111111-1111-1111-1111-111111111111' }).whopConnectionId).toBeUndefined();
  });

  it('accepts Whop fields and rejects a malformed page id', () => {
    expect(campaignDraftSchema.safeParse({ name: 'W', adProvider: 'WHOP', whopConnectionId: CONN, whopPageId: 'sacc_AbC123xyz' }).success).toBe(true);
    expect(campaignDraftSchema.safeParse({ name: 'W', adProvider: 'WHOP', whopPageId: '<script>' }).success).toBe(false);
    expect(campaignDraftSchema.safeParse({ name: 'W', adProvider: 'TIKTOK' }).success).toBe(false);
  });
});

describe('campaignSubmitIssues for a Whop campaign', () => {
  const whop = (over: Record<string, unknown> = {}, ad: Record<string, unknown> = {}, set: Record<string, unknown> = {}) =>
    campaignDraftSchema.parse({
      name: 'Senior SUV offers',
      adProvider: 'WHOP',
      objective: 'OUTCOME_LEADS',
      whopConnectionId: CONN,
      whopPageId: 'sacc_AbC123xyz',
      keywords: ['suv deals'],
      racValue: 'compare suv lease deals',
      adSets: [{ name: 'US', dailyBudgetCents: 2500, countries: ['US'], ads: [{ name: 'Ad A', headline: 'Compare SUV deals', primaryText: 'See what you qualify for.', uploadId: UPLOAD, ...ad }], ...set }],
      ...over,
    });

  it('is submittable with a connection, a page and complete ads, and needs no Facebook account, page or pixel', () => {
    expect(campaignSubmitIssues(whop())).toEqual([]);
  });

  it('asks for the Whop business and page instead of the Facebook ad account, page and pixel', () => {
    const issues = campaignSubmitIssues(whop({ whopConnectionId: undefined, whopPageId: undefined }));
    expect(issues).toContain('Select a Whop business.');
    expect(issues).toContain('Select the Facebook page your Whop ads run under.');
    expect(issues.join(' ')).not.toMatch(/ad account|pixel|\$2\.00|Facebook minimum/);
  });

  it('has no $2.00 Facebook floor: Whop\'s own floor is $5.00, and submit refuses anything under it', () => {
    expect(campaignSubmitIssues(whop({}, {}, { dailyBudgetCents: 500 }))).toEqual([]);
    const under = campaignSubmitIssues(whop({}, {}, { dailyBudgetCents: 150 })).join(' ');
    expect(under).toContain("Whop's minimum daily budget is $5.00");
    expect(under).not.toMatch(/\$2\.00|Facebook minimum/);
  });

  it('requires a creative, a headline and primary text on every ad (Whop\'s copy is not optional)', () => {
    const issues = campaignSubmitIssues(whop({}, { uploadId: undefined, headline: undefined, primaryText: undefined }));
    expect(issues).toEqual(['Ad 1.1 ("Ad A") needs a creative.', 'Ad 1.1 ("Ad A") needs a headline.', 'Ad 1.1 ("Ad A") needs primary text.']);
  });

  it('reports what Whop cannot express (objective, placements), before anything is created', () => {
    const issues = campaignSubmitIssues(whop({ objective: 'OUTCOME_APP_PROMOTION' }, {}, { placementMode: 'manual', placements: ['facebook_feed', 'messenger_inbox'] }));
    expect(issues).toContain('Whop does not run app-promotion campaigns.');
    expect(issues).toContain('Whop cannot target these placements: messenger_inbox.');
  });

  it('still applies the shared offer rules: keywords and a Referrer Ad Creative', () => {
    const issues = campaignSubmitIssues(whop({ keywords: [], racValue: undefined }));
    expect(issues).toContain('Add at least one keyword.');
    expect(issues).toContain('Set the Referrer Ad Creative.');
  });

  it('leaves the Facebook gate exactly as it was', () => {
    const fb = campaignDraftSchema.parse({ name: 'FB', keywords: ['x'], racValue: 'compare suv lease deals', adSets: [{ name: 'S', dailyBudgetCents: 500, countries: ['US'], ads: [{ name: 'A', uploadId: UPLOAD }] }] });
    expect(campaignSubmitIssues(fb)).toEqual(['Select a Facebook ad account.', 'Select a Facebook page.', 'Ad set 1 ("S") optimizes for conversions → it needs a pixel.']);
  });
});
