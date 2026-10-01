import { describe, expect, it } from 'vitest';
import {
  WHOP_CTAS,
  WHOP_MIN_DAILY_BUDGET_CENTS,
  WHOP_PLACEMENT,
  type WhopLaunchAdSet,
  type WhopLaunchCampaign,
  whopConversionEvent,
  whopCta,
  whopLaunchProblems,
  whopUnsupportedProblems,
} from './whop-launch.js';

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

describe('Whop launch vocabulary', () => {
  it('maps the ad set\'s optimized stage to Whop\'s event', () => {
    expect(whopConversionEvent('adclick')).toBe('submit_application');
    expect(whopConversionEvent('search')).toBe('add_to_cart');
    expect(whopConversionEvent('lander')).toBe('view_content');
    expect(whopConversionEvent('nonsense')).toBe('submit_application');
    expect(whopConversionEvent(undefined)).toBe('submit_application');
  });

  it('falls back to learn_more for a call to action Whop does not have', () => {
    expect(whopCta('LEARN_MORE')).toBe('learn_more');
    expect(whopCta('SHOP_NOW')).toBe('shop_now');
    expect(whopCta('GET_SHOWTIMES')).toBe('learn_more');
    expect(whopCta(undefined)).toBe('learn_more');
    expect(WHOP_CTAS).toContain('learn_more');
  });
});

describe('whopLaunchProblems: what Whop cannot express is reported before anything is created', () => {
  it('is empty for a campaign Whop can run as built', () => {
    expect(whopLaunchProblems(campaign, [adSet])).toEqual([]);
  });

  it('flags objectives, categories, placements and bid strategies Whop lacks', () => {
    const problems = whopLaunchProblems(
      { ...campaign, objective: 'OUTCOME_APP_PROMOTION', specialAdCategories: ['ONLINE_GAMBLING_AND_GAMING'] },
      [{ ...adSet, placementMode: 'manual', placements: ['facebook_feed', 'messenger_inbox', 'facebook_video_feeds'], bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' }],
    );
    expect(problems).toEqual([
      'Whop does not run app-promotion campaigns.',
      'Whop has no "online gambling and gaming" special ad category.',
      'Whop cannot target these placements: messenger_inbox, facebook_video_feeds.',
      'Whop has no ROAS-goal bid strategy.',
    ]);
  });

  it('flags missing budgets and countries, and a cap strategy without an amount', () => {
    expect(whopLaunchProblems(campaign, [{ ...adSet, dailyBudgetCents: null }])).toContain('Set a daily budget.');
    expect(whopLaunchProblems({ ...campaign, budgetMode: 'CAMPAIGN', dailyBudgetCents: null }, [{ ...adSet, dailyBudgetCents: null }])).toContain('Set a daily budget for the campaign.');
    expect(whopLaunchProblems(campaign, [{ ...adSet, countries: [] }])).toContain('Pick at least one country.');
    expect(whopLaunchProblems(campaign, [{ ...adSet, bidStrategy: 'COST_CAP', costCapCents: null }])).toContain('The bid strategy needs a cost or bid cap amount.');
  });

  it('names the ad set when there are several', () => {
    const problems = whopLaunchProblems(campaign, [adSet, { ...adSet, name: 'EU', countries: [] }]);
    expect(problems).toEqual(['Pick at least one country (ad set "EU").']);
  });

  it('refuses manual placements with nothing picked (that is an ad set with nowhere to run), but not automatic ones', () => {
    expect(whopLaunchProblems(campaign, [{ ...adSet, placementMode: 'manual', placements: [] }])).toEqual(['Pick at least one placement.']);
    expect(whopLaunchProblems(campaign, [{ ...adSet, placementMode: 'automatic', placements: [] }])).toEqual([]);
    expect(whopLaunchProblems(campaign, [adSet, { ...adSet, name: 'EU', placementMode: 'manual', placements: [] }])).toEqual(['Pick at least one placement (ad set "EU").']);
    expect(whopLaunchProblems(campaign, [{ ...adSet, placementMode: 'manual', placements: ['facebook_feed'] }])).toEqual([]);
  });

  it('separates what Whop cannot express at all from what is merely not filled in yet', () => {
    const unfinished = { ...campaign, budgetMode: 'CAMPAIGN' as const, dailyBudgetCents: null };
    const bare = { ...adSet, countries: [], dailyBudgetCents: null };
    // An unfinished form has problems, but none of them is "Whop cannot run this".
    expect(whopLaunchProblems(unfinished, [bare])).not.toEqual([]);
    expect(whopUnsupportedProblems(unfinished, [bare])).toEqual([]);
    // What a Facebook campaign may carry that Whop has no word for:
    expect(
      whopUnsupportedProblems(
        { objective: 'OUTCOME_APP_PROMOTION', specialAdCategories: ['ONLINE_GAMBLING_AND_GAMING', 'HOUSING'] },
        [{ name: 'US', placementMode: 'manual', placements: ['facebook_feed', 'facebook_video_feeds'], bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' }],
      ),
    ).toEqual([
      'Whop does not run app-promotion campaigns.',
      'Whop has no "online gambling and gaming" special ad category.',
      'Whop cannot target these placements: facebook_video_feeds.',
      'Whop has no ROAS-goal bid strategy.',
    ]);
    // Every one of them is also reported by the full list (which is what the server's submit gate runs).
    const full = whopLaunchProblems({ ...campaign, specialAdCategories: ['ONLINE_GAMBLING_AND_GAMING'] }, [{ ...adSet, placementMode: 'manual', placements: ['facebook_video_feeds'] }]);
    expect(full).toEqual(expect.arrayContaining(['Whop has no "online gambling and gaming" special ad category.', 'Whop cannot target these placements: facebook_video_feeds.']));
  });

  it('knows every one of our placement keys', () => {
    expect(Object.keys(WHOP_PLACEMENT)).toHaveLength(16);
    expect(Object.entries(WHOP_PLACEMENT).filter(([, v]) => v === null).map(([k]) => k)).toEqual(['facebook_video_feeds', 'messenger_inbox']);
  });
});

describe('whopLaunchProblems: the two refusals Whop gave real campaigns (2026-10-01)', () => {
  it('knows Whop\'s daily budget floor is $5.00', () => {
    expect(WHOP_MIN_DAILY_BUDGET_CENTS).toBe(500);
  });

  it('refuses a campaign-level budget under $5.00, and accepts exactly $5.00', () => {
    const cbo = { ...campaign, budgetMode: 'CAMPAIGN' as const };
    expect(whopLaunchProblems({ ...cbo, dailyBudgetCents: 499 }, [{ ...adSet, dailyBudgetCents: null }])).toEqual(["Whop's minimum daily budget is $5.00: raise the campaign budget."]);
    expect(whopLaunchProblems({ ...cbo, dailyBudgetCents: 100 }, [{ ...adSet, dailyBudgetCents: null }])).toHaveLength(1);
    expect(whopLaunchProblems({ ...cbo, dailyBudgetCents: 500 }, [{ ...adSet, dailyBudgetCents: null }])).toEqual([]);
  });

  it('refuses an ad-set budget under $5.00 and names the ad set when there are several', () => {
    expect(whopLaunchProblems(campaign, [{ ...adSet, dailyBudgetCents: 300 }])).toEqual(["Whop's minimum daily budget is $5.00: raise the budget."]);
    expect(whopLaunchProblems(campaign, [adSet, { ...adSet, name: 'EU', dailyBudgetCents: 499 }])).toEqual(['Whop\'s minimum daily budget is $5.00: raise the budget for ad set "EU".']);
    expect(whopLaunchProblems(campaign, [{ ...adSet, dailyBudgetCents: 500 }])).toEqual([]);
  });

  it('a special ad category campaign must not narrow the age range: 18 to 65', () => {
    const employment = { ...campaign, specialAdCategories: ['EMPLOYMENT'] };
    const msg = 'Whop does not let a special ad category campaign narrow the age range: set 18 to 65.';
    expect(whopLaunchProblems(employment, [{ ...adSet, ageMin: 20, ageMax: 65 }])).toEqual([msg]); // the real refusal: min 20
    expect(whopLaunchProblems(employment, [{ ...adSet, ageMin: 18, ageMax: 55 }])).toEqual([msg]);
    expect(whopLaunchProblems(employment, [{ ...adSet, ageMin: 18, ageMax: 65 }])).toEqual([]);
    expect(whopLaunchProblems({ ...campaign, specialAdCategories: ['CREDIT'] }, [{ ...adSet, ageMin: 18, ageMax: 65 }])).toEqual([]);
  });

  it('names the ad set for the age rule, and leaves a campaign with no special category free to narrow', () => {
    const employment = { ...campaign, specialAdCategories: ['HOUSING'] };
    expect(whopLaunchProblems(employment, [{ ...adSet, ageMin: 18 }, { ...adSet, name: 'Older', ageMin: 40 }])).toEqual([
      'Whop does not let a special ad category campaign narrow the age range: set 18 to 65 (ad set "Older").',
    ]);
    expect(whopLaunchProblems(campaign, [{ ...adSet, ageMin: 35, ageMax: 55 }])).toEqual([]);
  });

  it('does not double-report a category Whop does not have (that is already its own message)', () => {
    const problems = whopLaunchProblems({ ...campaign, specialAdCategories: ['ONLINE_GAMBLING_AND_GAMING'] }, [adSet]);
    expect(problems).toEqual(['Whop has no "online gambling and gaming" special ad category.']);
  });
});

