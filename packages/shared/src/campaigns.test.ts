import { describe, expect, it } from 'vitest';
import { adInputSchema, campaignDraftSchema, campaignSubmitIssues } from './campaigns.js';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';
const UUID_D = '44444444-4444-4444-4444-444444444444';

describe('campaign draft schema', () => {
  it('applies defaults on a minimal draft', () => {
    const parsed = campaignDraftSchema.parse({ name: 'Test' });
    expect(parsed.objective).toBe('OUTCOME_SALES');
    expect(parsed.optimizationGoal).toBe('OFFSITE_CONVERSIONS');
    expect(parsed.keywords).toEqual([]);
    expect(parsed.adSets).toEqual([]);
  });

  it('requires a name', () => {
    expect(campaignDraftSchema.safeParse({}).success).toBe(false);
  });

  it('defaults ad cta and pxe event', () => {
    const ad = adInputSchema.parse({ name: 'A', headline: 'H', primaryText: 'P' });
    expect(ad.cta).toBe('LEARN_MORE');
    expect(ad.pxeEvent).toBe('search');
    expect(ad.creativeType).toBe('IMAGE');
  });

  it('rejects a daily budget below $1.00', () => {
    const res = campaignDraftSchema.safeParse({
      name: 'x',
      adSets: [{ name: 's', dailyBudgetCents: 50 }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects an ad missing a headline', () => {
    const res = adInputSchema.safeParse({ name: 'A', primaryText: 'P' });
    expect(res.success).toBe(false);
  });
});

describe('campaignSubmitIssues', () => {
  it('flags every missing piece of an empty draft', () => {
    const draft = campaignDraftSchema.parse({ name: 'x' });
    const issues = campaignSubmitIssues(draft);
    expect(issues).toContain('Select a Facebook ad account.');
    expect(issues).toContain('Select a Facebook page.');
    expect(issues).toContain('Add at least one keyword.');
    expect(issues).toContain('Add at least one ad set.');
  });

  it('flags ads missing creative or pixel', () => {
    const draft = campaignDraftSchema.parse({
      name: 'x',
      keywords: ['a'],
      racValue: 'health',
      adAccountId: UUID_A,
      pageId: UUID_B,
      adSets: [{ name: 's', dailyBudgetCents: 500, ads: [{ name: 'a', headline: 'h', primaryText: 'p' }] }],
    });
    const issues = campaignSubmitIssues(draft);
    expect(issues.some((i) => i.includes('needs a creative'))).toBe(true);
    expect(issues.some((i) => i.includes('needs a pixel'))).toBe(true);
  });

  it('passes for a fully-specified campaign', () => {
    const draft = campaignDraftSchema.parse({
      name: 'x',
      keywords: ['a', 'b'],
      racValue: 'health insurance',
      adAccountId: UUID_A,
      pageId: UUID_B,
      adSets: [
        {
          name: 's',
          dailyBudgetCents: 500,
          ads: [
            { name: 'a', headline: 'h', primaryText: 'p', uploadId: UUID_C, pixelId: UUID_D },
          ],
        },
      ],
    });
    expect(campaignSubmitIssues(draft)).toEqual([]);
  });
});
