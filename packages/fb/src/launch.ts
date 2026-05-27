import { graphRequest } from './graph.js';

/**
 * Facebook Marketing API *write* layer — creates Campaign → Ad Set → Ad Creative
 * → Ad on an ad account. Object/array params are JSON-stringified as Graph expects
 * in form-encoded bodies. All calls go through the per-account rate limiter.
 */
interface CreatedId {
  id: string;
}

function postEdge<T>(
  fbAccountId: string,
  accessToken: string,
  edge: string,
  params: Record<string, string>,
): Promise<T> {
  return graphRequest<T>({
    path: `/act_${fbAccountId}/${edge}`,
    method: 'POST',
    params,
    accessToken,
    accountId: fbAccountId,
  });
}

export interface FbCampaignParams {
  name: string;
  objective: string;
  specialAdCategories: string[];
  status?: string;
  dailyBudgetCents?: number;
  bidStrategy?: string;
}

export function createFbCampaign(
  fbAccountId: string,
  accessToken: string,
  p: FbCampaignParams,
): Promise<CreatedId> {
  const params: Record<string, string> = {
    name: p.name,
    objective: p.objective,
    status: p.status ?? 'PAUSED',
    special_ad_categories: JSON.stringify(p.specialAdCategories ?? []),
    buying_type: 'AUCTION',
  };
  if (p.dailyBudgetCents != null) params.daily_budget = String(p.dailyBudgetCents);
  if (p.bidStrategy) params.bid_strategy = p.bidStrategy;
  return postEdge<CreatedId>(fbAccountId, accessToken, 'campaigns', params);
}

export interface FbAdSetParams {
  name: string;
  campaignId: string;
  optimizationGoal: string;
  billingEvent: string;
  targeting: Record<string, unknown>;
  dailyBudgetCents?: number;
  bidStrategy?: string;
  promotedObject?: Record<string, unknown>;
  startTime?: string;
  endTime?: string;
  status?: string;
}

export function createFbAdSet(
  fbAccountId: string,
  accessToken: string,
  p: FbAdSetParams,
): Promise<CreatedId> {
  const params: Record<string, string> = {
    name: p.name,
    campaign_id: p.campaignId,
    optimization_goal: p.optimizationGoal,
    billing_event: p.billingEvent,
    status: p.status ?? 'PAUSED',
    targeting: JSON.stringify(p.targeting),
    bid_strategy: p.bidStrategy ?? 'LOWEST_COST_WITHOUT_CAP',
  };
  if (p.dailyBudgetCents != null) params.daily_budget = String(p.dailyBudgetCents);
  if (p.promotedObject) params.promoted_object = JSON.stringify(p.promotedObject);
  if (p.startTime) params.start_time = p.startTime;
  if (p.endTime) params.end_time = p.endTime;
  return postEdge<CreatedId>(fbAccountId, accessToken, 'adsets', params);
}

/** Upload an image (base64 bytes) → returns the image hash for use in a creative. */
export async function uploadFbAdImage(
  fbAccountId: string,
  accessToken: string,
  base64Bytes: string,
): Promise<string> {
  const res = await postEdge<{ images: Record<string, { hash: string }> }>(
    fbAccountId,
    accessToken,
    'adimages',
    { bytes: base64Bytes },
  );
  const first = Object.values(res.images)[0];
  if (!first) throw new Error('Image upload returned no hash');
  return first.hash;
}

export interface FbCreativeParams {
  name: string;
  objectStorySpec: Record<string, unknown>;
}

export function createFbAdCreative(
  fbAccountId: string,
  accessToken: string,
  p: FbCreativeParams,
): Promise<CreatedId> {
  return postEdge<CreatedId>(fbAccountId, accessToken, 'adcreatives', {
    name: p.name,
    object_story_spec: JSON.stringify(p.objectStorySpec),
  });
}

export interface FbAdParams {
  name: string;
  adSetId: string;
  creativeId: string;
  status?: string;
}

export function createFbAd(
  fbAccountId: string,
  accessToken: string,
  p: FbAdParams,
): Promise<CreatedId> {
  return postEdge<CreatedId>(fbAccountId, accessToken, 'ads', {
    name: p.name,
    adset_id: p.adSetId,
    creative: JSON.stringify({ creative_id: p.creativeId }),
    status: p.status ?? 'PAUSED',
  });
}
