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

/**
 * Update the daily budget of an existing FB CAMPAIGN (campaign budget optimization / CBO).
 * `dailyBudgetCents` is in the ad account's currency minor units (same unit Facebook returned
 * and that `createFbCampaign` writes). Budget edits do NOT re-trigger ad review, so this is a
 * safe live-optimization action. Goes through the per-account rate limiter like every write.
 */
export function updateFbCampaignBudget(
  fbCampaignId: string,
  fbAccountId: string,
  accessToken: string,
  dailyBudgetCents: number,
  appKind: FbAppKind = 'DATA',
): Promise<{ success?: boolean }> {
  return graphRequest<{ success?: boolean }>({
    path: `/${fbCampaignId}`,
    method: 'POST',
    params: { daily_budget: String(dailyBudgetCents) },
    accessToken,
    accountId: fbAccountId,
    appKind,
  });
}

/**
 * Update the daily budget of an existing FB AD SET (ad-set budget optimization / ABO). Same
 * unit + same no-re-review property as `updateFbCampaignBudget`; the only difference is the
 * budget lives on the ad set under ABO, so the edge is the ad-set id.
 */
export function updateFbAdSetBudget(
  fbAdSetId: string,
  fbAccountId: string,
  accessToken: string,
  dailyBudgetCents: number,
  appKind: FbAppKind = 'DATA',
): Promise<{ success?: boolean }> {
  return graphRequest<{ success?: boolean }>({
    path: `/${fbAdSetId}`,
    method: 'POST',
    params: { daily_budget: String(dailyBudgetCents) },
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

/**
 * Upload a VIDEO creative → returns the FB video id for use in a creative's `video_data`.
 *
 * The image path (`adimages`, base64 `bytes`) does NOT accept video — posting a video there is
 * exactly what yields Facebook's "We could not process the image that you have uploaded." Video
 * goes to the ad account's `/advideos` edge as a multipart `source` file upload. Gated by the
 * per-account rate limiter like every account-scoped write.
 */
export async function uploadFbAdVideo(
  fbAccountId: string,
  accessToken: string,
  video: { bytes: Buffer; filename: string; mimeType: string },
  appKind: FbAppKind = 'DATA',
): Promise<string> {
  const form = new FormData();
  form.set('source', new Blob([video.bytes], { type: video.mimeType || 'video/mp4' }), video.filename || 'video.mp4');
  const res = await graphRequest<{ id?: string }>({
    path: `/act_${fbAccountId}/advideos`,
    method: 'POST',
    form,
    accessToken,
    accountId: fbAccountId,
    appKind,
  });
  if (!res.id) throw new Error('Video upload returned no id');
  return res.id;
}

interface VideoThumbnailsResponse {
  thumbnails?: { data?: { uri?: string; is_preferred?: boolean }[] };
}

/**
 * A video creative's `video_data` REQUIRES a thumbnail (`image_url` or `image_hash`). Facebook
 * processes uploads asynchronously and auto-generates thumbnails a few seconds in, so poll the
 * video node until one is ready. Returns the preferred thumbnail URI (else the first), or `null`
 * if none appears within the budget (caller surfaces an actionable "still processing — relaunch").
 * `sleep` is injectable so tests don't actually wait.
 */
export async function fetchFbVideoThumbnail(
  videoId: string,
  accessToken: string,
  appKind: FbAppKind = 'DATA',
  opts: { accountId?: string; attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | null> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 2500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i += 1) {
    const res = await graphRequest<VideoThumbnailsResponse>({
      path: `/${videoId}`,
      method: 'GET',
      params: { fields: 'thumbnails' },
      accessToken,
      accountId: opts.accountId,
      appKind,
    });
    const thumbs = res.thumbnails?.data ?? [];
    const preferred = thumbs.find((t) => t.is_preferred && t.uri) ?? thumbs.find((t) => t.uri);
    if (preferred?.uri) return preferred.uri;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}

export interface FbCreativeParams {
  name: string;
  objectStorySpec: Record<string, unknown>;
  /** Appended to the destination on click, with FB macros substituted (e.g. `kaid={{ad.id}}`) —
   *  lets the cloaker verify the click came from the expected ad. */
  urlTags?: string;
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
    { name: p.name, object_story_spec: JSON.stringify(p.objectStorySpec), ...(p.urlTags ? { url_tags: p.urlTags } : {}) },
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
  /** fbAccountIds WITHOUT the `act_` prefix. */
  accountIds?: string[];
  pageIds?: string[];
  pixelIds?: string[];
}
export interface AssetAccessResult {
  missingAccountIds: string[];
  missingPageIds: string[];
  missingPixelIds: string[];
  /** True when this token can see every requested asset. */
  ok: boolean;
}

/**
 * Verify a token can actually SEE the given assets — each is a cheap id-only GET. Facebook
 * grants asset access PER APP at consent, so a separate LAUNCH app can be missing an ad
 * account / Page / pixel that the DATA app synced; referencing it in a create then fails
 * with a confusing "the ad account and pixel don't match" error AFTER half the campaign is
 * built. Used two ways: (1) the launcher checks the specific campaign assets before creating
 * anything (fail fast, no orphans); (2) the connect flow checks ALL the user's assets so the
 * buyer knows the launch app has full coverage before they ever clone/relaunch.
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
  const checkAll = (ids: string[] | undefined, toPath: (id: string) => string, scoped: boolean) =>
    Promise.all((ids ?? []).map(async (id) => [id, await canSee(toPath(id), scoped ? id : undefined)] as const));
  const [accountChecks, pageChecks, pixelChecks] = await Promise.all([
    checkAll(assets.accountIds, (id) => `/act_${id}`, true),
    checkAll(assets.pageIds, (id) => `/${id}`, false),
    checkAll(assets.pixelIds, (id) => `/${id}`, false),
  ]);
  const missing = (checks: ReadonlyArray<readonly [string, boolean]>) => checks.filter(([, seen]) => !seen).map(([id]) => id);
  const missingAccountIds = missing(accountChecks);
  const missingPageIds = missing(pageChecks);
  const missingPixelIds = missing(pixelChecks);
  return {
    missingAccountIds,
    missingPageIds,
    missingPixelIds,
    ok: missingAccountIds.length === 0 && missingPageIds.length === 0 && missingPixelIds.length === 0,
  };
}
