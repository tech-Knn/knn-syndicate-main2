import { z } from 'zod';
import {
  ATTRIBUTION_WINDOWS,
  CONVERSION_TYPES,
  DEVICE_PLATFORMS,
  MOBILE_OS,
  SPECIAL_AD_CATEGORIES,
} from './facebook-options.js';

/**
 * Campaign / ad-set / ad validation, shared by the API (source of truth) and the
 * launch wizard. Mirrors Facebook's structure: a campaign is the "offer" (D5–D7,
 * keywords/RAC/query); each ad set carries audience (geo/age/gender), placements,
 * budget, and the pixel + conversion event (D10 revised — at the ad set, not the
 * ad); each ad is a creative variation with its own redirect (D9).
 *
 * `campaignDraftSchema` is lenient (save a half-built draft); `campaignSubmitIssues`
 * is the strict completeness gate applied at submit.
 */

export const CAMPAIGN_OBJECTIVES = [
  'OUTCOME_SALES',
  'OUTCOME_LEADS',
  'OUTCOME_TRAFFIC',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_AWARENESS',
  'OUTCOME_APP_PROMOTION',
] as const;
export type CampaignObjective = (typeof CAMPAIGN_OBJECTIVES)[number];

/**
 * Performance goals (Facebook `optimization_goal`) offered per campaign objective for a
 * WEBSITE conversion location — our funnel always drives traffic to the article site.
 * Encoded from Meta's Outcome-Driven Ads (ODAX) model; Facebook does the final
 * validation at launch. Keep the first entry as the sensible default for each objective.
 */
export const PERFORMANCE_GOALS_BY_OBJECTIVE: Record<CampaignObjective, readonly string[]> = {
  OUTCOME_SALES: ['OFFSITE_CONVERSIONS', 'VALUE', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
  OUTCOME_LEADS: ['OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
  OUTCOME_ENGAGEMENT: ['OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'POST_ENGAGEMENT', 'REACH', 'IMPRESSIONS'],
  OUTCOME_TRAFFIC: ['LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
  OUTCOME_AWARENESS: ['REACH', 'IMPRESSIONS', 'AD_RECALL_LIFT'],
  OUTCOME_APP_PROMOTION: ['LINK_CLICKS'],
} as const;

/** Goals that optimize for a pixel conversion → require a pixel `promoted_object`. */
export const PIXEL_REQUIRED_GOALS: ReadonlySet<string> = new Set(['OFFSITE_CONVERSIONS', 'VALUE']);

/** Goals that send people to a website → the ad set carries `destination_type: WEBSITE`. */
export const WEBSITE_DESTINATION_GOALS: ReadonlySet<string> = new Set([
  'OFFSITE_CONVERSIONS',
  'VALUE',
  'LANDING_PAGE_VIEWS',
  'LINK_CLICKS',
]);

/** Human labels for the performance-goal dropdown. */
export const PERFORMANCE_GOAL_LABELS: Record<string, string> = {
  OFFSITE_CONVERSIONS: 'Conversions',
  VALUE: 'Value',
  LANDING_PAGE_VIEWS: 'Landing-page views',
  LINK_CLICKS: 'Link clicks',
  POST_ENGAGEMENT: 'Post engagement',
  REACH: 'Reach',
  IMPRESSIONS: 'Impressions',
  AD_RECALL_LIFT: 'Ad recall lift',
};

export function performanceGoalsFor(objective: CampaignObjective): readonly string[] {
  return PERFORMANCE_GOALS_BY_OBJECTIVE[objective] ?? [];
}
export function isValidPerformanceGoal(objective: CampaignObjective, goal: string): boolean {
  return performanceGoalsFor(objective).includes(goal);
}
export function defaultPerformanceGoal(objective: CampaignObjective): string {
  return performanceGoalsFor(objective)[0] ?? 'LINK_CLICKS';
}
export function goalRequiresPixel(goal: string): boolean {
  return PIXEL_REQUIRED_GOALS.has(goal);
}

export const BUDGET_MODES = ['AD_SET', 'CAMPAIGN'] as const;
export type BudgetMode = (typeof BUDGET_MODES)[number];

export const CTA_OPTIONS = [
  'LEARN_MORE',
  'SHOP_NOW',
  'SIGN_UP',
  'SUBSCRIBE',
  'GET_OFFER',
  'DOWNLOAD',
  'GET_QUOTE',
  'CONTACT_US',
  'APPLY_NOW',
  'SEE_MORE',
  'BOOK_TRAVEL',
  'ORDER_NOW',
] as const;
export type CtaOption = (typeof CTA_OPTIONS)[number];

/** The conversion event the ad set optimizes/attributes on (D10); set per ad set. */
export const PXE_EVENTS = ['lander', 'search', 'adclick'] as const;
export type PxeEvent = (typeof PXE_EVENTS)[number];

export const CREATIVE_TYPES = ['IMAGE', 'VIDEO'] as const;
export type CreativeType = (typeof CREATIVE_TYPES)[number];

export const GENDERS = ['male', 'female'] as const; // empty selection = all
export type Gender = (typeof GENDERS)[number];

export const PLACEMENT_MODES = ['automatic', 'manual'] as const;
export type PlacementMode = (typeof PLACEMENT_MODES)[number];

export const PLACEMENT_PLATFORMS = ['facebook', 'instagram', 'audience_network', 'messenger'] as const;
export type PlacementPlatform = (typeof PLACEMENT_PLATFORMS)[number];

export const AGE_BOUND_MIN = 13;
export const AGE_BOUND_MAX = 65;

const uuid = z.string().uuid();
const optionalUrl = z.string().url().optional();

/** One ad — a creative variation. Pixel/conversion event live on the ad set, not here. */
export const adInputSchema = z.object({
  name: z.string().trim().min(1, 'Ad name is required').max(120),
  headline: z.string().trim().min(1, 'Headline is required').max(120),
  primaryText: z.string().trim().min(1, 'Primary text is required').max(2000),
  description: z.string().trim().max(500).optional(),
  cta: z.enum(CTA_OPTIONS).default('LEARN_MORE'),
  creativeType: z.enum(CREATIVE_TYPES).default('IMAGE'),
  uploadId: uuid.optional(),
  fallbackUrl: optionalUrl,
  beneficiary: z.string().trim().max(120).optional(),
  /**
   * Optional display link — the visible URL caption shown in the ad (FB `link_data.caption`),
   * INDEPENDENT of the actual destination (the `/go/{redirectId}` redirect). A domain or full URL,
   * e.g. "yourbrand.com". Facebook expects it to plausibly reflect the destination/business
   * (a wildly unrelated display link risks disapproval), and it's ignored on Instagram placements.
   */
  displayLink: z.string().trim().max(255).regex(/^\S+\.\S+$/, 'Display link must be a domain or URL').optional(),
});
export type AdInput = z.input<typeof adInputSchema>;

export const adSetInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Ad set name is required').max(120),
    // Optional: under campaign budget optimization (CBO) the budget is on the campaign.
    dailyBudgetCents: z.number().int().min(100, 'Minimum daily budget is $1.00').optional(),
    billingEvent: z.string().default('IMPRESSIONS'),
    optimizationGoal: z.string().default('OFFSITE_CONVERSIONS'),
    bidStrategy: z.string().optional(),
    // Audience.
    countries: z.array(z.string().length(2)).max(200).default([]),
    ageMin: z.number().int().min(AGE_BOUND_MIN).max(AGE_BOUND_MAX).default(18),
    ageMax: z.number().int().min(AGE_BOUND_MIN).max(AGE_BOUND_MAX).default(AGE_BOUND_MAX),
    genders: z.array(z.enum(GENDERS)).default([]),
    // Placements (granular position keys when manual; see PLACEMENT_OPTIONS).
    placementMode: z.enum(PLACEMENT_MODES).default('automatic'),
    placements: z.array(z.string()).max(40).default([]),
    // Extended targeting (parity).
    excludeCountries: z.array(z.string().length(2)).max(200).default([]),
    languages: z.array(z.string()).max(50).default([]),
    devicePlatforms: z.array(z.enum(DEVICE_PLATFORMS)).default([]),
    mobileOs: z.array(z.enum(MOBILE_OS)).default([]),
    advantageAudience: z.boolean().default(false),
    // Conversion tracking (ad-set level).
    pixelId: uuid.optional(),
    pxeEvent: z.enum(PXE_EVENTS).default('adclick'),
    conversionType: z.enum(CONVERSION_TYPES).default('instant'),
    // Optimization knobs.
    costCapCents: z.number().int().min(1).optional(),
    roasFactor: z.number().min(0).optional(),
    attributionWindow: z.enum(ATTRIBUTION_WINDOWS).optional(),
    // Schedule.
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    timezone: z.string().optional(),
    ads: z.array(adInputSchema).max(20).default([]),
  })
  .refine((s) => s.ageMax >= s.ageMin, {
    message: 'Maximum age must be greater than or equal to minimum age',
    path: ['ageMax'],
  });
export type AdSetInput = z.input<typeof adSetInputSchema>;

/** Lenient draft — `name` is the only hard requirement; the rest is filled in across the wizard. */
export const campaignDraftSchema = z.object({
  name: z.string().trim().min(1, 'Campaign name is required').max(120),
  objective: z.enum(CAMPAIGN_OBJECTIVES).default('OUTCOME_SALES'),
  optimizationGoal: z.string().default('OFFSITE_CONVERSIONS'),
  specialAdCategories: z.array(z.enum(SPECIAL_AD_CATEGORIES)).default([]),
  nameTemplate: z.string().trim().max(200).optional(),
  adsetNameTemplate: z.string().trim().max(200).optional(),
  budgetMode: z.enum(BUDGET_MODES).default('AD_SET'),
  // Campaign budget (cents) — used under CBO.
  dailyBudgetCents: z.number().int().min(100, 'Minimum daily budget is $1.00').optional(),
  keywords: z.array(z.string().trim().min(1)).max(50).default([]),
  racValue: z.string().trim().max(200).optional(),
  // Landing-page angle that drives article generation (Phase 5).
  query: z.string().trim().max(300).optional(),
  fallbackUrl: optionalUrl,
  adAccountId: uuid.optional(),
  pageId: uuid.optional(),
  adSets: z.array(adSetInputSchema).max(20).default([]),
});
export type CampaignDraftInput = z.input<typeof campaignDraftSchema>;
export type CampaignDraft = z.infer<typeof campaignDraftSchema>;

/** Strict completeness gate for DRAFT → PENDING_APPROVAL. Empty list = submittable. */
export function campaignSubmitIssues(c: CampaignDraft): string[] {
  const issues: string[] = [];
  if (!c.adAccountId) issues.push('Select a Facebook ad account.');
  if (!c.pageId) issues.push('Select a Facebook page.');
  if (c.keywords.length === 0) issues.push('Add at least one keyword.');
  if (!c.racValue) issues.push('Set the RAC (Related Ad Category) value.');
  if (c.budgetMode === 'CAMPAIGN' && !c.dailyBudgetCents) {
    issues.push('Set the campaign daily budget (campaign budget optimization is on).');
  }
  if (c.budgetMode === 'CAMPAIGN' && c.dailyBudgetCents && c.dailyBudgetCents < 200) {
    issues.push('Campaign daily budget must be at least $2.00 (Facebook minimum).');
  }
  if (c.adSets.length === 0) issues.push('Add at least one ad set.');
  c.adSets.forEach((set, i) => {
    const label = `Ad set ${i + 1} ("${set.name}")`;
    if (c.budgetMode === 'AD_SET' && !set.dailyBudgetCents) issues.push(`${label} needs a daily budget.`);
    if (c.budgetMode === 'AD_SET' && set.dailyBudgetCents && set.dailyBudgetCents < 200) {
      issues.push(`${label} daily budget must be at least $2.00 (Facebook minimum).`);
    }
    if (set.countries.length === 0) issues.push(`${label} needs at least one target country.`);
    // The performance goal must be valid for the campaign objective (ODAX).
    if (!isValidPerformanceGoal(c.objective, set.optimizationGoal)) {
      issues.push(`${label}: "${PERFORMANCE_GOAL_LABELS[set.optimizationGoal] ?? set.optimizationGoal}" isn't a valid performance goal for the ${c.objective.replace('OUTCOME_', '').toLowerCase()} objective.`);
    }
    // A pixel is only required when optimizing for a conversion (not for clicks/reach/etc.).
    if (goalRequiresPixel(set.optimizationGoal) && !set.pixelId) {
      issues.push(`${label} optimizes for conversions → it needs a pixel.`);
    }
    if (set.placementMode === 'manual' && set.placements.length === 0) {
      issues.push(`${label} needs at least one placement.`);
    }
    if (set.ads.length === 0) issues.push(`${label} needs at least one ad.`);
    set.ads.forEach((ad, j) => {
      if (!ad.uploadId) issues.push(`Ad ${i + 1}.${j + 1} ("${ad.name}") needs a creative.`);
    });
  });
  return issues;
}
