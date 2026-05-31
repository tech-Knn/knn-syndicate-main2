import { type FbAppKind } from './app-creds.js';
import { graphRequest } from './graph.js';

/**
 * Facebook Marketing API *write* layer — creates Campaign → Ad Set → Ad Creative
 * → Ad on an ad account. Object/array params are JSON-stringified as Graph expects
 * in form-encoded bodies. All calls go through the per-account rate limiter.
 *
 * Every write takes a trailing optional `appKind`: writes use the short-lived LAUNCH
 * app token when one is connected (it clears the 31/3858385 checkpoint), so the call
 * must carry that app's kind for the appsecret_proof. Defaults to 'DATA'.
 */
interface CreatedId {
  id: string;
}

function postEdge<T>(
  fbAccountId: string,
  accessToken: string,
  edge: string,
  params: Record<string, string>,
  appKind: FbAppKind = 'DATA',
): Promise<T> {
  return graphRequest<T>({
    path: `/act_${fbAccountId}/${edge}`,
    method: 'POST',
    params,
    accessToken,
    accountId: fbAccountId,
    appKind,
  });
}

/** Pause or resume an existing FB campaign (the optimization action). */
export function updateFbCampaignStatus(
  fbCampaignId: string,
  fbAccountId: string,
  accessToken: string,
  status: 'ACTIVE' | 'PAUSED',
  appKind: FbAppKind = 'DATA',
): Promise<{ success?: boolean }> {
  return graphRequest<{ success?: boolean }>({
    path: `/${fbCampaignId}`,
    method: 'POST',
    params: { status },
    accessToken,
    accountId: fbAccountId,
    appKind,
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
  appKind: FbAppKind = 'DATA',
): Promise<CreatedId> {
  const params: Record<string, string> = {
    name: p.name,
    objective: p.objective,
    status: p.status ?? 'PAUSED',
    special_ad_categories: JSON.stringify(p.specialAdCategories ?? []),
    buying_type: 'AUCTION',
  };
  if (p.dailyBudgetCents != null) {
    params.daily_budget = String(p.dailyBudgetCents);
    if (p.bidStrategy) params.bid_strategy = p.bidStrategy;
  } else {
    // ABO (no campaign budget): Facebook requires this flag to be set explicitly.
    params.is_adset_budget_sharing_enabled = 'false';
  }
  return postEdge<CreatedId>(fbAccountId, accessToken, 'campaigns', params, appKind);
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
  /** e.g. 'WEBSITE' — required for website conversion-location ad sets (ODAX). */
  destinationType?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
}

export function createFbAdSet(
  fbAccountId: string,
  accessToken: string,
  p: FbAdSetParams,
  appKind: FbAppKind = 'DATA',
): Promise<CreatedId> {
  const params: Record<string, string> = {
    name: p.name,
    campaign_id: p.campaignId,
    optimization_goal: p.optimizationGoal,
    billing_event: p.billingEvent,
    status: p.status ?? 'PAUSED',
    targeting: JSON.stringify(p.targeting),
  };
  // Only ABO ad sets carry a bid strategy; under CBO it lives on the campaign and
  // the ad set must NOT set one (Facebook rejects the conflict). Caller decides.
  if (p.bidStrategy) params.bid_strategy = p.bidStrategy;
  if (p.destinationType) params.destination_type = p.destinationType;
  if (p.dailyBudgetCents != null) params.daily_budget = String(p.dailyBudgetCents);
  if (p.promotedObject) params.promoted_object = JSON.stringify(p.promotedObject);
  if (p.startTime) params.start_time = p.startTime;
  if (p.endTime) params.end_time = p.endTime;
  return postEdge<CreatedId>(fbAccountId, accessToken, 'adsets', params, appKind);
}

/** Upload an image (base64 bytes) → returns the image hash for use in a creative. */
export async function uploadFbAdImage(
  fbAccountId: string,
  accessToken: string,
  base64Bytes: string,
  appKind: FbAppKind = 'DATA',
): Promise<string> {
  const res = await postEdge<{ images: Record<string, { hash: string }> }>(
    fbAccountId,
    accessToken,
    'adimages',
    { bytes: base64Bytes },
    appKind,
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
  appKind: FbAppKind = 'DATA',
): Promise<CreatedId> {
  return postEdge<CreatedId>(
    fbAccountId,
    accessToken,
    'adcreatives',
    { name: p.name, object_story_spec: JSON.stringify(p.objectStorySpec) },
    appKind,
  );
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
  appKind: FbAppKind = 'DATA',
): Promise<CreatedId> {
  return postEdge<CreatedId>(
    fbAccountId,
    accessToken,
    'ads',
    {
      name: p.name,
      adset_id: p.adSetId,
      creative: JSON.stringify({ creative_id: p.creativeId }),
      status: p.status ?? 'PAUSED',
    },
    appKind,
  );
}

export interface AssetAccessCheck {
  /** fbAccountId WITHOUT the `act_` prefix. */
  accountId?: string;
  fbPageId?: string;
  fbPixelIds?: string[];
}
export interface AssetAccessResult {
  missingAccount: boolean;
  missingPage: boolean;
  missingPixelIds: string[];
  /** Convenience: any asset inaccessible to this token. */
  ok: boolean;
}

/**
 * Verify a token can actually SEE the given assets — each is a cheap id-only GET. Facebook
 * grants asset access PER APP at consent, so a separate LAUNCH app can be missing an ad
 * account / Page / pixel that the DATA app synced; referencing it in a create then fails
 * with a confusing "the ad account and pixel don't match" error AFTER half the campaign is
 * built. Run this with the LAUNCH token BEFORE creating anything to fail fast + clearly.
 */
export async function checkAssetAccess(
  accessToken: string,
  assets: AssetAccessCheck,
  appKind: FbAppKind = 'DATA',
): Promise<AssetAccessResult> {
  const canSee = async (path: string, accountId?: string): Promise<boolean> => {
    try {
      await graphRequest({ path, params: { fields: 'id' }, accessToken, appKind, accountId });
      return true;
    } catch {
      return false;
    }
  };
  const [account, page, pixelChecks] = await Promise.all([
    assets.accountId ? canSee(`/act_${assets.accountId}`, assets.accountId) : Promise.resolve(true),
    assets.fbPageId ? canSee(`/${assets.fbPageId}`) : Promise.resolve(true),
    Promise.all((assets.fbPixelIds ?? []).map(async (px) => [px, await canSee(`/${px}`)] as const)),
  ]);
  const missingPixelIds = pixelChecks.filter(([, seen]) => !seen).map(([px]) => px);
  const missingAccount = !account;
  const missingPage = !page;
  return {
    missingAccount,
    missingPage,
    missingPixelIds,
    ok: !missingAccount && !missingPage && missingPixelIds.length === 0,
  };
}
