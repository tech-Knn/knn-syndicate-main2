import { describe, expect, it } from 'vitest';
import {
  adInputSchema,
  adSetInputSchema,
  campaignDraftSchema,
  campaignSubmitIssues,
  defaultPerformanceGoal,
  goalRequiresPixel,
  isValidPerformanceGoal,
  performanceGoalsFor,
} from './campaigns.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';
const D = '44444444-4444-4444-4444-444444444444';

describe('campaign draft schema', () => {
  it('applies defaults on a minimal draft', () => {
    const parsed = campaignDraftSchema.parse({ name: 'Test' });
    expect(parsed.objective).toBe('OUTCOME_SALES');
    expect(parsed.budgetMode).toBe('AD_SET');
    expect(parsed.keywords).toEqual([]);
    expect(parsed.adSets).toEqual([]);
  });

  it('requires a name', () => {
    expect(campaignDraftSchema.safeParse({}).success).toBe(false);
  });

  it('ads carry no pixel; defaults cta + creative type', () => {
    const ad = adInputSchema.parse({ name: 'A', headline: 'H', primaryText: 'P' });
    expect(ad.cta).toBe('LEARN_MORE');
    expect(ad.creativeType).toBe('IMAGE');
    expect('pixelId' in ad).toBe(false);
  });

  it('ad sets default audience + conversion fields', () => {
    const set = adSetInputSchema.parse({ name: 'S' });
    expect(set.pxeEvent).toBe('adclick');
    expect(set.placementMode).toBe('automatic');
    expect(set.ageMin).toBe(18);
    expect(set.ageMax).toBe(65);
    expect(set.countries).toEqual([]);
  });

  it('rejects a daily budget below $1.00', () => {
    expect(adSetInputSchema.safeParse({ name: 's', dailyBudgetCents: 50 }).success).toBe(false);
  });

  it('rejects an inverted age range', () => {
    expect(adSetInputSchema.safeParse({ name: 's', ageMin: 50, ageMax: 25 }).success).toBe(false);
  });
});

describe('ODAX performance-goal matrix', () => {
  it('offers website-conversion goals for the sales objective', () => {
    expect(performanceGoalsFor('OUTCOME_SALES')).toContain('OFFSITE_CONVERSIONS');
    expect(isValidPerformanceGoal('OUTCOME_SALES', 'OFFSITE_CONVERSIONS')).toBe(true);
  });

  it('lets the engagement objective drive website conversions (user-confirmed ODAX path)', () => {
    // Campaign objective Engagement → Conversion (website) is a valid Meta combo.
    expect(isValidPerformanceGoal('OUTCOME_ENGAGEMENT', 'OFFSITE_CONVERSIONS')).toBe(true);
  });

  it('rejects conversion optimization under the awareness objective', () => {
    expect(isValidPerformanceGoal('OUTCOME_AWARENESS', 'OFFSITE_CONVERSIONS')).toBe(false);
  });

  it('defaults each objective to its first (sensible) goal', () => {
    expect(defaultPerformanceGoal('OUTCOME_SALES')).toBe('OFFSITE_CONVERSIONS');
    expect(defaultPerformanceGoal('OUTCOME_TRAFFIC')).toBe('LANDING_PAGE_VIEWS');
    expect(defaultPerformanceGoal('OUTCOME_AWARENESS')).toBe('REACH');
  });

  it('requires a pixel only for conversion/value goals', () => {
    expect(goalRequiresPixel('OFFSITE_CONVERSIONS')).toBe(true);
    expect(goalRequiresPixel('VALUE')).toBe(true);
    expect(goalRequiresPixel('LINK_CLICKS')).toBe(false);
    expect(goalRequiresPixel('REACH')).toBe(false);
  });
});

describe('campaignSubmitIssues', () => {
  it('flags missing pieces of an empty draft', () => {
    const issues = campaignSubmitIssues(campaignDraftSchema.parse({ name: 'x' }));
    expect(issues).toContain('Select a Facebook ad account.');
    expect(issues).toContain('Add at least one ad set.');
  });

  it('flags an ad set missing country / pixel / creative', () => {
    const draft = campaignDraftSchema.parse({
      name: 'x',
      keywords: ['a'],
      racValue: 'health',
      adAccountId: A,
      pageId: B,
      adSets: [{ name: 's', dailyBudgetCents: 500, ads: [{ name: 'a', headline: 'h', primaryText: 'p' }] }],
    });
    const issues = campaignSubmitIssues(draft);
    expect(issues.some((i) => i.includes('target country'))).toBe(true);
    expect(issues.some((i) => i.includes('needs a pixel'))).toBe(true);
    expect(issues.some((i) => i.includes('needs a creative'))).toBe(true);
  });

  it('requires a campaign budget under CBO', () => {
    const draft = campaignDraftSchema.parse({
      name: 'x',
      budgetMode: 'CAMPAIGN',
      keywords: ['a'],
      racValue: 'health',
      adAccountId: A,
      pageId: B,
      adSets: [
        { name: 's', countries: ['US'], pixelId: D, ads: [{ name: 'a', headline: 'h', primaryText: 'p', uploadId: C }] },
      ],
    });
    expect(campaignSubmitIssues(draft).some((i) => i.includes('campaign daily budget'))).toBe(true);
  });

  it('flags a performance goal that is invalid for the objective (ODAX)', () => {
    const draft = campaignDraftSchema.parse({
      name: 'x',
      keywords: ['a'],
      racValue: 'health',
      adAccountId: A,
      pageId: B,
      // AWARENESS can't optimize for OFFSITE_CONVERSIONS.
      objective: 'OUTCOME_AWARENESS',
      adSets: [
        {
          name: 's',
          dailyBudgetCents: 5000,
          countries: ['US'],
          optimizationGoal: 'OFFSITE_CONVERSIONS',
          ads: [{ name: 'a', headline: 'h', primaryText: 'p', uploadId: C }],
        },
      ],
    });
    expect(campaignSubmitIssues(draft).some((i) => i.includes("isn't a valid performance goal"))).toBe(true);
  });

  it('does not require a pixel when optimizing for link clicks', () => {
    const draft = campaignDraftSchema.parse({
      name: 'x',
      keywords: ['a'],
      racValue: 'health',
      adAccountId: A,
      pageId: B,
      objective: 'OUTCOME_TRAFFIC',
      adSets: [
        {
          name: 's',
          dailyBudgetCents: 5000,
          countries: ['US'],
          optimizationGoal: 'LINK_CLICKS', // no pixel needed
          ads: [{ name: 'a', headline: 'h', primaryText: 'p', uploadId: C }],
        },
      ],
    });
    expect(campaignSubmitIssues(draft)).toEqual([]);
  });

  it('flags an ad-set budget below the $2.00 Facebook minimum', () => {
    const draft = campaignDraftSchema.parse({
      name: 'x',
      keywords: ['a'],
      racValue: 'health',
      adAccountId: A,
      pageId: B,
      adSets: [
        {
          name: 's',
          dailyBudgetCents: 150, // parses (>= $1) but below the $2 launch floor
          countries: ['US'],
          pixelId: D,
          ads: [{ name: 'a', headline: 'h', primaryText: 'p', uploadId: C }],
        },
      ],
    });
    expect(campaignSubmitIssues(draft).some((i) => i.includes('at least $2.00'))).toBe(true);
  });

  it('passes for a complete ABO campaign', () => {
    const draft = campaignDraftSchema.parse({
      name: 'x',
      keywords: ['a', 'b'],
      racValue: 'health insurance',
      adAccountId: A,
      pageId: B,
      adSets: [
        {
          name: 's',
          dailyBudgetCents: 5000,
          countries: ['US', 'CA'],
          pixelId: D,
          ads: [{ name: 'a', headline: 'h', primaryText: 'p', uploadId: C }],
        },
      ],
    });
    expect(campaignSubmitIssues(draft)).toEqual([]);
  });
});
