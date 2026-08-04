import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_OBJECTIVES,
  SELECTABLE_OBJECTIVES,
  adInputSchema,
  adSetInputSchema,
  campaignDraftSchema,
  campaignSubmitIssues,
  defaultPerformanceGoal,
  goalRequiresPixel,
  isValidPerformanceGoal,
  performanceGoalsFor,
  racValueIssues,
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

  it('accepts an ad with NO headline or primary text (both optional, like Facebook)', () => {
    const res = adInputSchema.safeParse({ name: 'A' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.headline).toBeUndefined();
      expect(res.data.primaryText).toBeUndefined();
    }
  });

  it('SELECTABLE_OBJECTIVES is the launcher subset (Sales/Leads/Engagement), all valid objectives', () => {
    expect(SELECTABLE_OBJECTIVES).toEqual(['OUTCOME_SALES', 'OUTCOME_LEADS', 'OUTCOME_ENGAGEMENT']);
    for (const o of SELECTABLE_OBJECTIVES) expect(CAMPAIGN_OBJECTIVES).toContain(o);
    // The excluded ones remain valid in the schema (back-compat) but aren't offered.
    expect(SELECTABLE_OBJECTIVES).not.toContain('OUTCOME_TRAFFIC');
    expect(SELECTABLE_OBJECTIVES).not.toContain('OUTCOME_AWARENESS');
    expect(SELECTABLE_OBJECTIVES).not.toContain('OUTCOME_APP_PROMOTION');
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
      racValue: 'health insurance',
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
      racValue: 'health insurance',
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
      racValue: 'health insurance',
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
      racValue: 'health insurance',
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
      racValue: 'health insurance',
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

  it('flags racValue that matches the campaign name (Google returns zero terms)', () => {
    const draft = campaignDraftSchema.parse({
      name: 'Second Hand Car - Test',
      keywords: ['a'],
      racValue: 'Second Hand Car - Test',
      adAccountId: A,
      pageId: B,
      objective: 'OUTCOME_TRAFFIC',
      adSets: [
        {
          name: 's',
          dailyBudgetCents: 5000,
          countries: ['US'],
          optimizationGoal: 'LINK_CLICKS',
          ads: [{ name: 'a', headline: 'h', primaryText: 'p', uploadId: C }],
        },
      ],
    });
    expect(campaignSubmitIssues(draft).some((i) => i.includes('not the campaign name'))).toBe(true);
  });

  it('flags a single-word racValue', () => {
    const draft = campaignDraftSchema.parse({
      name: 'x',
      keywords: ['a'],
      racValue: 'insurance',
      adAccountId: A,
      pageId: B,
      objective: 'OUTCOME_TRAFFIC',
      adSets: [
        {
          name: 's',
          dailyBudgetCents: 5000,
          countries: ['US'],
          optimizationGoal: 'LINK_CLICKS',
          ads: [{ name: 'a', headline: 'h', primaryText: 'p', uploadId: C }],
        },
      ],
    });
    expect(campaignSubmitIssues(draft).some((i) => i.includes('at least two words'))).toBe(true);
  });
});

describe('racValueIssues', () => {
  it('returns [] when blank (missing is a separate required-field issue)', () => {
    expect(racValueIssues('', 'anything')).toEqual([]);
    expect(racValueIssues(null, 'anything')).toEqual([]);
    expect(racValueIssues(undefined, 'anything')).toEqual([]);
    expect(racValueIssues('   ', 'anything')).toEqual([]);
  });

  it('accepts a real multi-word search phrase', () => {
    expect(racValueIssues('used cars under 10000', 'My Campaign')).toEqual([]);
    expect(racValueIssues('affordable health insurance plans', 'Insurance Q1')).toEqual([]);
  });

  it('flags a value that matches the campaign name (case-insensitive)', () => {
    const issues = racValueIssues('Second Hand Car', 'second hand car');
    expect(issues.some((i) => i.includes('not the campaign name'))).toBe(true);
  });

  it('flags a single-word value', () => {
    const issues = racValueIssues('insurance', 'Insurance Q1');
    expect(issues.some((i) => i.includes('at least two words'))).toBe(true);
  });
});
