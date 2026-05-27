import { z } from 'zod';

/**
 * Campaign / ad-set / ad validation, shared by the API (source of truth) and the
 * launch wizard (client-side UX validation). A campaign is the "offer" (D5–D7):
 * keywords/RAC live here; ads are creative variations with a per-ad pxe (D10).
 *
 * Two levels: `campaignDraftSchema` is lenient (you can save a half-built draft);
 * `campaignSubmitIssues` is the strict completeness gate applied at submit.
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

/** Pixel conversion event the ad optimizes/attributes on (D10); maps to the pixel's configured events. */
export const PXE_EVENTS = ['lander', 'search', 'adclick'] as const;
export type PxeEvent = (typeof PXE_EVENTS)[number];

export const CREATIVE_TYPES = ['IMAGE', 'VIDEO'] as const;
export type CreativeType = (typeof CREATIVE_TYPES)[number];

const uuid = z.string().uuid();
const optionalUrl = z.string().url().optional();

/** One ad. Headline/text are required; the creative (`uploadId`) and `pixelId` can be attached later in a draft. */
export const adInputSchema = z.object({
  name: z.string().trim().min(1, 'Ad name is required').max(120),
  headline: z.string().trim().min(1, 'Headline is required').max(120),
  primaryText: z.string().trim().min(1, 'Primary text is required').max(2000),
  description: z.string().trim().max(500).optional(),
  cta: z.enum(CTA_OPTIONS).default('LEARN_MORE'),
  creativeType: z.enum(CREATIVE_TYPES).default('IMAGE'),
  uploadId: uuid.optional(),
  pxeEvent: z.enum(PXE_EVENTS).default('search'),
  pixelId: uuid.optional(),
  fallbackUrl: optionalUrl,
  beneficiary: z.string().trim().max(120).optional(),
});
export type AdInput = z.input<typeof adInputSchema>;

export const adSetInputSchema = z.object({
  name: z.string().trim().min(1, 'Ad set name is required').max(120),
  dailyBudgetCents: z
    .number()
    .int('Budget must be a whole number of cents')
    .min(100, 'Minimum daily budget is $1.00'),
  billingEvent: z.string().default('IMPRESSIONS'),
  optimizationGoal: z.string().default('OFFSITE_CONVERSIONS'),
  targeting: z.record(z.unknown()).default({}),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  ads: z.array(adInputSchema).max(20).default([]),
});
export type AdSetInput = z.input<typeof adSetInputSchema>;

/** Lenient draft — `name` is the only hard requirement; the rest is filled in across the wizard. */
export const campaignDraftSchema = z.object({
  name: z.string().trim().min(1, 'Campaign name is required').max(120),
  objective: z.enum(CAMPAIGN_OBJECTIVES).default('OUTCOME_SALES'),
  optimizationGoal: z.string().default('OFFSITE_CONVERSIONS'),
  keywords: z.array(z.string().trim().min(1)).max(50).default([]),
  racValue: z.string().trim().max(200).optional(),
  fallbackUrl: optionalUrl,
  adAccountId: uuid.optional(),
  pageId: uuid.optional(),
  adSets: z.array(adSetInputSchema).max(20).default([]),
});
export type CampaignDraftInput = z.input<typeof campaignDraftSchema>;
export type CampaignDraft = z.infer<typeof campaignDraftSchema>;

/**
 * Strict completeness gate for moving DRAFT → PENDING_APPROVAL. Returns a list of
 * human-readable issues; an empty list means the campaign is submittable.
 */
export function campaignSubmitIssues(c: CampaignDraft): string[] {
  const issues: string[] = [];
  if (!c.adAccountId) issues.push('Select a Facebook ad account.');
  if (!c.pageId) issues.push('Select a Facebook page.');
  if (c.keywords.length === 0) issues.push('Add at least one keyword.');
  if (!c.racValue) issues.push('Set the RAC (Related Ad Category) value.');
  if (c.adSets.length === 0) issues.push('Add at least one ad set.');
  c.adSets.forEach((set, i) => {
    if (set.ads.length === 0) issues.push(`Ad set ${i + 1} ("${set.name}") needs at least one ad.`);
    set.ads.forEach((ad, j) => {
      if (!ad.uploadId) issues.push(`Ad ${i + 1}.${j + 1} ("${ad.name}") needs a creative.`);
      if (!ad.pixelId) issues.push(`Ad ${i + 1}.${j + 1} ("${ad.name}") needs a pixel.`);
    });
  });
  return issues;
}
