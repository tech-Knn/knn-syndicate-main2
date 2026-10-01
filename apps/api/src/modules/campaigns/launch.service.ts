import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '@knn/config';
import { FbConnectionStatus, type TxClient } from '@knn/db';
import {
  type FbAppKind,
  FbAccountRestrictedError,
  FbApiError,
  FbConnectionBrokenError,
  FbRateLimitError,
  TokenDecryptError,
  checkAssetAccess,
  createFbAd,
  createFbAdCreative,
  createFbAdSet,
  createFbCampaign,
  decryptToken,
  fetchFbVideoThumbnail,
  hasLaunchApp,
  updateFbAdSetBudget,
  updateFbCampaignBudget,
  updateFbCampaignStatus,
  uploadFbAdImage,
  uploadFbAdVideo,
} from '@knn/fb';
import { CAMPAIGN_STATUS, ROLES, WEBSITE_DESTINATION_GOALS, campaignSubmitIssues, canTransitionCampaign, effectiveRac, goalRequiresPixel, pxeToCustomEventType } from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { requestChannelsForResumedCampaign } from '../../lib/channel-queue.js';
import { KvNotConfiguredError, type RedirectConfigPayload, writeRedirectConfigs } from '../../lib/kv-sync.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { markConnectionBroken } from '../facebook/facebook.service.js';
import { generateArticleForCampaign } from '../articles/articles.service.js';
import { type CampaignWithChildren, campaignInclude, reopenCampaign, toDraft } from './campaigns.service.js';
import { pickWhiteDomain, resolveBuyerFunnelMode, resolveRedirectBase, syncCampaignRedirectConfigs, withCustomTerms } from './launch-routing.js';
import { setWhopCampaignActive, updateWhopAdSetBudget, updateWhopCampaignBudget } from './whop-controls.service.js';
import { type WhopLaunchDeps, launchWhopCampaign, relaunchWhopCampaign } from './whop-launch.service.js';

// Existing callers import these from here; they now live in launch-routing.ts (shared with the Whop launch).
export { syncCampaignRedirectConfigs, withCustomTerms };

/**
 * Decrypt a stored FB connection token, mapping an undecryptable value (rotated
 * TOKEN_ENCRYPTION_KEY / corrupt ciphertext) to a clean, actionable 409 instead of a raw Node
 * crypto 500 (ERR_CRYPTO_INVALID_AUTH_TAG). The token is dead either way — the only recovery
 * is for the owner to reconnect the Facebook profile.
 */
function decryptConnectionToken(accessTokenEnc: string): string {
  try {
    return decryptToken(accessTokenEnc);
  } catch (err) {
    if (err instanceof TokenDecryptError) {
      throw new AppError(
        409,
        'This Facebook connection can no longer be used (its stored access token is unreadable) — reconnect the profile in Settings → Facebook, then try again.',
      );
    }
    throw err;
  }
}

/** The connection that OWNS the campaign's ad account (always a DATA connection). */
interface OwningConnection {
  id: string;
  userId: string;
  fbUserId: string;
  accessTokenEnc: string;
  status: FbConnectionStatus;
  /** Which app owns this connection — VERIFY (Advanced Access) publishes directly. */
  appKind: string;
  tokenExpiresAt: Date;
}
interface WriteAuth {
  token: string;
  appKind: FbAppKind;
  /** The connection whose token we're using — so a token break (err 190) marks the right one. */
  connectionId: string;
}

/**
 * Resolve the credential for FB *writes* (create/modify ads). When a separate LAUNCH app
 * is configured, FB ad-publish must use the LAUNCH token — it's what clears the 31/3858385
 * checkpoint; falling back to the DATA token would just trip it again. So if the connecting
 * user has a LAUNCH connection it MUST be usable (else a clean, actionable "reconnect the
 * launch app" 409). With no launch app configured — or no LAUNCH connection for this user
 * yet — we use the DATA connection exactly as before (single-app, backwards-compatible).
 *
 * NB: matched by our internal `userId`, NOT `fb_user_id` — Facebook returns a DIFFERENT
 * app-scoped user id per app for the same person, so the DATA and LAUNCH connections never
 * share an `fb_user_id` (verified on staging: 995168526234717 vs 996495602768676). The
 * connecting KNN user is the stable join key. Pick the freshest LAUNCH connection.
 */
async function resolveWriteAuth(tx: TxClient, dataConn: OwningConnection): Promise<WriteAuth> {
  // A VERIFY connection is the Advanced-Access app: its own long-lived ads_management token
  // both syncs assets AND publishes ads. It is self-sufficient — use it directly, no LAUNCH detour.
  if (dataConn.appKind === 'VERIFY') {
    if (dataConn.status === FbConnectionStatus.CONNECTION_BROKEN || dataConn.tokenExpiresAt.getTime() <= Date.now()) {
      throw new AppError(
        409,
        'Your Facebook verification-app connection needs reconnecting — open Settings → Facebook → Connect verification app, then relaunch.',
      );
    }
    return { token: decryptConnectionToken(dataConn.accessTokenEnc), appKind: 'VERIFY', connectionId: dataConn.id };
  }
  if (hasLaunchApp()) {
    // Only a HEALTHY launch connection qualifies — push the health check into the query so a
    // dead/expired LAUNCH row simply doesn't match (rather than hard-failing the write).
    const launch = await tx.fbConnection.findFirst({
      where: {
        userId: dataConn.userId,
        appKind: 'LAUNCH',
        status: FbConnectionStatus.ACTIVE,
        tokenExpiresAt: { gt: new Date() },
      },
      orderBy: { tokenExpiresAt: 'desc' },
      select: { id: true, accessTokenEnc: true },
    });
    if (launch) {
      return { token: decryptConnectionToken(launch.accessTokenEnc), appKind: 'LAUNCH', connectionId: launch.id };
    }
    // No healthy LAUNCH connection → fall through to DATA below (no 409). A dead/abandoned
    // LAUNCH app must not block writes when a working DATA token exists.
  }
  if (dataConn.status === FbConnectionStatus.CONNECTION_BROKEN) {
    throw new AppError(409, 'Facebook connection is broken — reconnect first');
  }
  return { token: decryptConnectionToken(dataConn.accessTokenEnc), appKind: 'DATA', connectionId: dataConn.id };
}

export interface FbStructureResult {
  fbCampaignId: string;
  /** The stable Meta ad-account id we launched under — persisted so reads survive a deleted
   *  connection row (resolve a live token by the Meta id, not the session-bound row). */
  fbAccountId: string;
  adSets: { id: string; fbAdSetId: string; ads: { id: string; fbAdId: string }[] }[];
  /** The redirect (go.*) host this launch rotated onto — recorded on the campaign for blast-radius. */
  redirectDomainHost?: string;
}
export type TestLaunchResult = FbStructureResult;

/**
 * Progress hooks for a REAL launch. Each Facebook object is recorded the moment it exists — before
 * the next Graph call — so a build interrupted by a rate limit (or any later failure) is RESUMED by
 * the next attempt instead of rebuilt from scratch. `campaigns.fb_campaign_id` is deliberately NOT
 * touched here: it keeps meaning "fully built" for every reader, so the in-progress campaign goes in
 * `fb_pending_campaign_id` and only becomes `fb_campaign_id` when the whole structure is done.
 * Omitted by the test launch, which always builds a fresh PAUSED structure.
 */
interface FbBuildRecorder {
  campaign(p: { fbCampaignId: string; redirectDomainHost: string }): Promise<void>;
  adSet(p: { adSetId: string; fbAdSetId: string }): Promise<void>;
  ad(p: { adId: string; fbAdId: string }): Promise<void>;
}

type StoredAdSet = CampaignWithChildren['adSets'][number];

interface LaunchPlan {
  campaign: CampaignWithChildren;
  token: string;
  /** Which app issued `token` (DATA or the short-lived LAUNCH app) — for appsecret_proof. */
  appKind: FbAppKind;
  fbAccountId: string;
  fbPageId: string;
  /** The connection whose token we're using — so a token break can mark it (D13). */
  connectionId: string;
  adSets: {
    set: StoredAdSet;
    fbPixelId: string | null;
    // `creativeKind` drives the FB build: IMAGE → adimages + link_data.image_hash; VIDEO →
    // advideos + video_data.video_id (with an auto-generated thumbnail). mimeType/filename are
    // passed to the multipart video upload.
    ads: { ad: StoredAdSet['ads'][number]; storageKey: string | null; creativeKind: 'IMAGE' | 'VIDEO'; mimeType: string | null; filename: string | null }[];
  }[];
}

/** Core FB targeting spec from an ad set (geo / age / gender / device / OS). */
function buildTargeting(set: StoredAdSet): Record<string, unknown> {
  const t: Record<string, unknown> = {
    geo_locations: { countries: set.countries },
    age_min: set.ageMin,
    age_max: set.ageMax,
  };
  if (set.excludeCountries.length > 0) t.excluded_geo_locations = { countries: set.excludeCountries };
  const genders = set.genders.map((g) => (g === 'male' ? 1 : 2));
  if (genders.length > 0) t.genders = genders;
  if (set.devicePlatforms.length > 0) t.device_platforms = set.devicePlatforms;
  if (set.mobileOs.length > 0) t.user_os = set.mobileOs.map((o) => (o === 'ios' ? 'iOS' : 'Android'));
  // Facebook requires an explicit Advantage+ audience decision in the targeting spec.
  t.targeting_automation = { advantage_audience: set.advantageAudience ? 1 : 0 };
  return t;
}

/** Read phase — validate + resolve FB ids + the owner's token. No network in the txn. */
async function resolveLaunchPlan(auth: AuthContext, campaignId: string): Promise<LaunchPlan> {
  return runScoped(auth, async (tx) => {
    const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, include: campaignInclude });
    if (!campaign) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && campaign.buyerId !== auth.userId) {
      throw new AppError(404, 'Campaign not found');
    }
    // The Facebook plan builder, and the test launch that uses it, are Facebook only (D33). A Whop campaign is
    // checked by Whop itself when its ads are created, and launches through `launchWhopCampaign`.
    if (campaign.adProvider === 'WHOP') {
      throw new AppError(409, 'Test launch is for Facebook campaigns. Whop checks a campaign when its ads are created: launch it from the campaign page.');
    }

    const issues = campaignSubmitIssues(toDraft(campaign));
    if (issues.length > 0) throw new AppError(422, 'Campaign is not complete enough to launch', issues);
    if (!campaign.adAccountId || !campaign.pageId) throw new AppError(400, 'Campaign is missing its ad account or page');

    // The ad account is owned by a DATA connection (a buyer may have several profiles, so
    // we must not assume one). Writes, though, use the matching LAUNCH token when present.
    const [adAccount, page] = await Promise.all([
      tx.fbAdAccount.findUnique({
        where: { id: campaign.adAccountId },
        select: {
          fbAccountId: true,
          connection: { select: { id: true, userId: true, fbUserId: true, accessTokenEnc: true, status: true, appKind: true, tokenExpiresAt: true } },
        },
      }),
      tx.fbPage.findUnique({ where: { id: campaign.pageId }, select: { fbPageId: true } }),
    ]);
    if (!adAccount || !page) throw new AppError(400, 'Selected ad account/page no longer exists');
    const writeAuth = await resolveWriteAuth(tx, adAccount.connection);

    const adSets = await Promise.all(
      campaign.adSets.map(async (set) => {
        const pixel = set.pixelId
          ? await tx.fbPixel.findUnique({ where: { id: set.pixelId }, select: { fbPixelId: true } })
          : null;
        const ads = await Promise.all(
          set.ads.map(async (ad) => {
            const upload = ad.uploadId
              ? await tx.upload.findUnique({ where: { id: ad.uploadId }, select: { storageKey: true, kind: true, mimeType: true, filename: true } })
              : null;
            return {
              ad,
              storageKey: upload?.storageKey ?? null,
              // The file's actual kind is the source of truth for which FB upload path to use
              // (more reliable than the denormalized Ad.creativeType copy).
              creativeKind: upload?.kind === 'VIDEO' ? 'VIDEO' : 'IMAGE',
              mimeType: upload?.mimeType ?? null,
              filename: upload?.filename ?? null,
            } as const;
          }),
        );
        return { set, fbPixelId: pixel?.fbPixelId ?? null, ads };
      }),
    );

    return {
      campaign,
      token: writeAuth.token,
      appKind: writeAuth.appKind,
      fbAccountId: adAccount.fbAccountId,
      fbPageId: page.fbPageId,
      connectionId: writeAuth.connectionId,
      adSets,
    };
  });
}

/**
 * Which ad network runs a campaign (D33). Every action that differs by provider asks this FIRST, before any side
 * effect or validation that only makes sense for one network (Facebook's $2 budget floor, for instance). Also the
 * scope check: a buyer only ever sees their own campaign, anything else is a 404.
 */
async function campaignProvider(auth: AuthContext, campaignId: string): Promise<'FACEBOOK' | 'WHOP'> {
  return runScoped(auth, async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId }, select: { adProvider: true, buyerId: true } });
    if (!c) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && c.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
    return c.adProvider;
  });
}

/**
 * Pause or resume a launched campaign — the core optimization action. Flips the FB
 * campaign's delivery status (network call done OUTSIDE the txn) AND the local status
 * (ACTIVE ↔ PAUSED). A buyer may only touch their own; admins/super their scope (RLS).
 * Requires the campaign to be ACTIVE or PAUSED; a no-op if already in the target state.
 */
export async function setCampaignActive(
  auth: AuthContext,
  campaignId: string,
  active: boolean,
  deps: Pick<LaunchDeps, 'writeRedirectConfigs' | 'requestChannels'> = { writeRedirectConfigs },
): Promise<{ id: string; status: string }> {
  if ((await campaignProvider(auth, campaignId)) === 'WHOP') return setWhopCampaignActive(auth, campaignId, active, deps);
  const target = active ? CAMPAIGN_STATUS.ACTIVE : CAMPAIGN_STATUS.PAUSED;

  // Read phase: validate scope/state and resolve the FB campaign + token (no network).
  const plan = await runScoped(auth, async (tx) => {
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, buyerId: true, orgId: true, status: true, fbCampaignId: true, adAccountId: true },
    });
    if (!campaign) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && campaign.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
    if (campaign.status === target) return { done: true as const, status: campaign.status };
    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE && campaign.status !== CAMPAIGN_STATUS.PAUSED) {
      throw new AppError(409, `Only an active or paused campaign can be ${active ? 'resumed' : 'paused'}`);
    }
    let fb: { fbCampaignId: string; fbAccountId: string; token: string; appKind: FbAppKind; connectionId: string } | null = null;
    if (campaign.fbCampaignId && campaign.adAccountId) {
      const acc = await tx.fbAdAccount.findUnique({
        where: { id: campaign.adAccountId },
        select: {
          fbAccountId: true,
          connection: { select: { id: true, userId: true, fbUserId: true, accessTokenEnc: true, status: true, appKind: true, tokenExpiresAt: true } },
        },
      });
      if (!acc) throw new AppError(400, 'Selected ad account no longer exists');
      const writeAuth = await resolveWriteAuth(tx, acc.connection);
      fb = { fbCampaignId: campaign.fbCampaignId, fbAccountId: acc.fbAccountId, token: writeAuth.token, appKind: writeAuth.appKind, connectionId: writeAuth.connectionId };
    }
    return { done: false as const, orgId: campaign.orgId, fb };
  });
  if (plan.done) return { id: campaignId, status: plan.status };

  // Network phase (outside any txn): tell Facebook to pause/resume delivery.
  if (plan.fb) {
    try {
      await updateFbCampaignStatus(plan.fb.fbCampaignId, plan.fb.fbAccountId, plan.fb.token, active ? 'ACTIVE' : 'PAUSED', plan.fb.appKind);
    } catch (err) {
      if (err instanceof FbRateLimitError) throw new AppError(429, 'Facebook is rate-limiting — try again in a moment');
      // Pause/resume is also a "modify" — same account security hold applies (FB code 368).
      if (err instanceof FbAccountRestrictedError) {
        throw new AppError(
          409,
          'Facebook has temporarily restricted this ad account for security ("authenticate your account in Ads Manager"). The account owner must complete the authentication prompt in Ads Manager, then try again.' +
          (err.checkpointUrl ? ` Authenticate here: ${err.checkpointUrl}` : ''),
        );
      }
      if (err instanceof FbConnectionBrokenError) {
        await markConnectionBroken(plan.fb.connectionId, err.message).catch(() => undefined);
        throw new AppError(409, 'This Facebook connection has expired or been revoked — reconnect the profile in Settings → Facebook, then try again.');
      }
      throw err;
    }
  }

  // Write phase: persist the new status + audit.
  const updated = await runScoped(auth, async (tx) => {
    const u = await tx.campaign.update({ where: { id: campaignId }, data: { status: target }, select: { id: true, status: true } });
    await writeAudit(tx, {
      orgId: plan.orgId,
      actorId: auth.userId,
      action: active ? 'campaign.resumed' : 'campaign.paused',
      entityType: 'campaign',
      entityId: campaignId,
    });
    return u;
  });

  // Sync the edge KV so the redirect's `active` flag matches the new status (B1): a PAUSED
  // campaign must STOP routing residual paid clicks to the monetized money-page — otherwise its
  // (soon-to-be-reassigned) channel keeps emitting and AFS revenue mis-attributes, possibly to a
  // DIFFERENT tenant. Resume re-enables it. `syncCampaignRedirectConfigs` derives active from the
  // current status. Best-effort: a KV hiccup must never fail an otherwise-successful pause/resume.
  await syncCampaignRedirectConfigs(campaignId, deps).catch((e) =>
    console.warn(`[setCampaignActive] edge KV resync failed for ${campaignId}:`, e instanceof Error ? e.message : String(e)),
  );
  // The midnight rollover releases a paused campaign's channel; resume asks the worker for one back (see the Whop twin).
  if (active) await (deps.requestChannels ?? requestChannelsForResumedCampaign)(campaignId);
  return updated;
}

/** Facebook's floor for a daily budget (account-currency minor units). Mirrors the submit-time
 *  check in `campaignSubmitIssues` so a live edit can't drop a campaign below the launchable floor. */
const MIN_DAILY_BUDGET_CENTS = 200;

/** Map a Facebook write error → an actionable AppError (shared by the budget edits). Always throws.
 *  Budget is a "modify", so the account security hold (code 368) applies, same as pause/resume. */
async function throwFbWriteError(err: unknown, connectionId: string): Promise<never> {
  if (err instanceof FbRateLimitError) throw new AppError(429, 'Facebook is rate-limiting — try again in a moment');
  if (err instanceof FbAccountRestrictedError) {
    throw new AppError(
      409,
      'Facebook has temporarily restricted this ad account for security ("authenticate your account in Ads Manager"). The account owner must complete the prompt in Ads Manager, then try again.' +
      (err.checkpointUrl ? ` Authenticate here: ${err.checkpointUrl}` : ''),
    );
  }
  if (err instanceof FbConnectionBrokenError) {
    await markConnectionBroken(connectionId, err.message).catch(() => undefined);
    throw new AppError(409, 'This Facebook connection has expired or been revoked — reconnect the profile in Settings → Facebook, then try again.');
  }
  throw err;
}

/**
 * LIVE BUDGET EDIT (the daily-driver action) — change a launched campaign's daily budget and push
 * it to Facebook WITHOUT releasing its AdSense channel or re-queuing for approval. This is the
 * deliberate, narrow hole in the launch-and-freeze model: budget is the one field Facebook lets you
 * change on a live campaign with no re-review, and scaling a winner / trimming a loser is the #1
 * thing a buyer does all day. Mirrors `setCampaignActive`'s read→network→write phases exactly.
 *
 * Scope (intentionally conservative): ACTIVE/PAUSED only (an FB campaign must exist); CBO writes the
 * campaign budget, single-ad-set ABO writes that ad set's budget. Multi-ad-set ABO is refused (we
 * will not silently re-distribute money across ad sets). NO channel release, NO edge-KV resync —
 * budget does not affect routing, so the channel mapping and the redirect config are untouched.
 */
export async function updateCampaignBudget(
  auth: AuthContext,
  campaignId: string,
  input: { dailyBudgetCents: number },
): Promise<{ id: string; dailyBudgetCents: number }> {
  if ((await campaignProvider(auth, campaignId)) === 'WHOP') return updateWhopCampaignBudget(auth, campaignId, input);
  const cents = input.dailyBudgetCents;
  if (!Number.isInteger(cents) || cents < MIN_DAILY_BUDGET_CENTS) {
    throw new AppError(422, `Daily budget must be at least $${(MIN_DAILY_BUDGET_CENTS / 100).toFixed(2)} (Facebook minimum).`);
  }

  // Read phase: validate scope/state, pick the FB write target by budget mode, resolve the token.
  const plan = await runScoped(auth, async (tx) => {
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true, buyerId: true, orgId: true, status: true, budgetMode: true, dailyBudgetCents: true,
        fbCampaignId: true, adAccountId: true,
        adSets: { select: { id: true, fbAdSetId: true, dailyBudgetCents: true } },
      },
    });
    if (!campaign) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && campaign.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE && campaign.status !== CAMPAIGN_STATUS.PAUSED) {
      throw new AppError(409, 'Only a live (active or paused) campaign’s budget can be edited here — reopen a draft to change its budget before launch.');
    }
    if (!campaign.fbCampaignId || !campaign.adAccountId) {
      throw new AppError(409, 'This campaign isn’t linked to a Facebook campaign yet.');
    }
    const acc = await tx.fbAdAccount.findUnique({
      where: { id: campaign.adAccountId },
      select: { fbAccountId: true, connection: { select: { id: true, userId: true, fbUserId: true, accessTokenEnc: true, status: true, appKind: true, tokenExpiresAt: true } } },
    });
    if (!acc) throw new AppError(400, 'Selected ad account no longer exists');

    // Pick the FB object that carries the budget for this campaign's mode.
    let target: { kind: 'campaign'; fbId: string } | { kind: 'adset'; fbId: string; adSetId: string };
    let oldCents: number | null;
    if (campaign.budgetMode === 'CAMPAIGN') {
      target = { kind: 'campaign', fbId: campaign.fbCampaignId };
      oldCents = campaign.dailyBudgetCents;
    } else {
      const launched = campaign.adSets.filter((s) => s.fbAdSetId);
      if (launched.length !== 1) {
        throw new AppError(
          409,
          launched.length === 0
            ? 'This campaign has no launched ad set to budget.'
            : 'This campaign uses per-ad-set budgets across multiple ad sets — edit each ad set’s budget individually (open the campaign to edit them).',
        );
      }
      target = { kind: 'adset', fbId: launched[0]!.fbAdSetId!, adSetId: launched[0]!.id };
      oldCents = launched[0]!.dailyBudgetCents;
    }

    const writeAuth = await resolveWriteAuth(tx, acc.connection);
    return { orgId: campaign.orgId, fbAccountId: acc.fbAccountId, token: writeAuth.token, appKind: writeAuth.appKind, connectionId: writeAuth.connectionId, target, oldCents };
  });

  // No-op if the budget didn't actually change (don't spend an FB write or an audit row).
  if (plan.oldCents === cents) return { id: campaignId, dailyBudgetCents: cents };

  // Network phase (outside any txn): push the new budget to Facebook. Same error policy as
  // pause/resume — budget is a "modify", so the account security hold (code 368) applies.
  try {
    if (plan.target.kind === 'campaign') {
      await updateFbCampaignBudget(plan.target.fbId, plan.fbAccountId, plan.token, cents, plan.appKind);
    } else {
      await updateFbAdSetBudget(plan.target.fbId, plan.fbAccountId, plan.token, cents, plan.appKind);
    }
  } catch (err) {
    await throwFbWriteError(err, plan.connectionId);
  }

  // Write phase: persist the new budget + audit. NO channel release, NO edge-KV resync —
  // budget doesn't change routing, so the channel mapping and redirect config stay exactly as they are.
  await runScoped(auth, async (tx) => {
    if (plan.target.kind === 'campaign') {
      await tx.campaign.update({ where: { id: campaignId }, data: { dailyBudgetCents: cents } });
    } else {
      await tx.adSet.update({ where: { id: plan.target.adSetId }, data: { dailyBudgetCents: cents } });
    }
    await writeAudit(tx, {
      orgId: plan.orgId,
      actorId: auth.userId,
      action: 'campaign.budget_updated',
      entityType: 'campaign',
      entityId: campaignId,
      details: { fromCents: plan.oldCents, toCents: cents },
    });
  });

  return { id: campaignId, dailyBudgetCents: cents };
}

/**
 * LIVE PER-AD-SET BUDGET EDIT — change ONE ad set's daily budget on a launched ABO campaign and push
 * it to Facebook, without releasing the channel. This is how a multi-ad-set ABO campaign's budget is
 * managed (each ad set carries its own budget under ABO); `updateCampaignBudget` only covers CBO +
 * single-ad-set ABO. Same conservative scope + error policy as `updateCampaignBudget`.
 */
export async function updateAdSetBudget(
  auth: AuthContext,
  campaignId: string,
  adSetId: string,
  input: { dailyBudgetCents: number },
): Promise<{ id: string; adSetId: string; dailyBudgetCents: number }> {
  if ((await campaignProvider(auth, campaignId)) === 'WHOP') return updateWhopAdSetBudget(auth, campaignId, adSetId, input);
  const cents = input.dailyBudgetCents;
  if (!Number.isInteger(cents) || cents < MIN_DAILY_BUDGET_CENTS) {
    throw new AppError(422, `Daily budget must be at least $${(MIN_DAILY_BUDGET_CENTS / 100).toFixed(2)} (Facebook minimum).`);
  }

  const plan = await runScoped(auth, async (tx) => {
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, buyerId: true, orgId: true, status: true, budgetMode: true, adAccountId: true },
    });
    if (!campaign) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && campaign.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE && campaign.status !== CAMPAIGN_STATUS.PAUSED) {
      throw new AppError(409, 'Only a live (active or paused) campaign’s budget can be edited here.');
    }
    if (campaign.budgetMode !== 'AD_SET') {
      throw new AppError(409, 'This campaign uses a single campaign budget (CBO) — edit the campaign budget instead.');
    }
    // The ad set must belong to THIS campaign (prevents cross-campaign id tampering) and be launched.
    const set = await tx.adSet.findFirst({ where: { id: adSetId, campaignId }, select: { id: true, fbAdSetId: true, dailyBudgetCents: true } });
    if (!set) throw new AppError(404, 'Ad set not found');
    if (!set.fbAdSetId || !campaign.adAccountId) throw new AppError(409, 'This ad set isn’t linked to Facebook yet.');
    const acc = await tx.fbAdAccount.findUnique({
      where: { id: campaign.adAccountId },
      select: { fbAccountId: true, connection: { select: { id: true, userId: true, fbUserId: true, accessTokenEnc: true, status: true, appKind: true, tokenExpiresAt: true } } },
    });
    if (!acc) throw new AppError(400, 'Selected ad account no longer exists');
    const writeAuth = await resolveWriteAuth(tx, acc.connection);
    return { orgId: campaign.orgId, fbAccountId: acc.fbAccountId, token: writeAuth.token, appKind: writeAuth.appKind, connectionId: writeAuth.connectionId, fbAdSetId: set.fbAdSetId, oldCents: set.dailyBudgetCents };
  });

  if (plan.oldCents === cents) return { id: campaignId, adSetId, dailyBudgetCents: cents };

  try {
    await updateFbAdSetBudget(plan.fbAdSetId, plan.fbAccountId, plan.token, cents, plan.appKind);
  } catch (err) {
    await throwFbWriteError(err, plan.connectionId);
  }

  await runScoped(auth, async (tx) => {
    await tx.adSet.update({ where: { id: adSetId }, data: { dailyBudgetCents: cents } });
    await writeAudit(tx, {
      orgId: plan.orgId,
      actorId: auth.userId,
      action: 'campaign.budget_updated',
      entityType: 'campaign',
      entityId: campaignId,
      details: { adSetId, fromCents: plan.oldCents, toCents: cents },
    });
  });

  return { id: campaignId, adSetId, dailyBudgetCents: cents };
}

/** FB write phase — campaign → ad sets → (image, creative, ad), all at `status`. */
/**
 * When launching through a separate LAUNCH app, verify ITS token can see the ad account,
 * Page and pixels first — Facebook grants assets per app, so a launch app that wasn't
 * granted the same assets as the DATA app would fail mid-build with a confusing "the ad
 * account and pixel don't match" error (and leave an orphan FB campaign). Fail fast + clear.
 */
async function assertLaunchAssetsAccessible(plan: LaunchPlan): Promise<void> {
  if (plan.appKind !== 'LAUNCH') return;
  const fbPixelIds = [...new Set(plan.adSets.map((s) => s.fbPixelId).filter((p): p is string => !!p))];
  const res = await checkAssetAccess(plan.token, { accountIds: [plan.fbAccountId], pageIds: [plan.fbPageId], pixelIds: fbPixelIds }, 'LAUNCH');
  if (res.ok) return;
  const missing = [
    ...res.missingAccountIds.map((a) => `ad account act_${a}`),
    ...res.missingPageIds.map((p) => `Page ${p}`),
    ...res.missingPixelIds.map((px) => `pixel ${px}`),
  ];
  throw new AppError(
    409,
    `Your Facebook launch app can't access ${missing.join(', ')}. These belong to your main connection but weren't granted to the launch app. Reconnect the launch app (Settings → Facebook → Connect launch app) and grant it the SAME ad accounts, Pages and pixels as your main profile, then relaunch.`,
  );
}

/**
 * Poll Facebook for a video's thumbnail after upload. FB processes videos asynchronously, so the
 * thumbnail is frequently not ready immediately — retry with backoff (~30s total across 6 attempts)
 * before giving up. Returns the thumbnail URL, or null if it never became available in the budget.
 */
async function pollForVideoThumbnail(
  videoId: string,
  token: string,
  appKind: FbAppKind,
  accountId: string,
): Promise<string | null> {
  // ms delays: 0 (immediate try), then 2s, 3s, 5s, 8s, 12s ≈ 30s total.
  const delays = [0, 2_000, 3_000, 5_000, 8_000, 12_000];
  for (let i = 0; i < delays.length; i++) {
    const delay = delays[i] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      const url = await fetchFbVideoThumbnail(videoId, token, appKind, { accountId });
      if (url) return url;
    } catch (err) {
      console.warn(`[launch] thumbnail poll ${i + 1}/${delays.length} for video ${videoId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

async function createFbStructure(
  plan: LaunchPlan,
  status: 'PAUSED' | 'ACTIVE',
  recorder?: FbBuildRecorder,
): Promise<FbStructureResult> {
  const { campaign, token, appKind, fbAccountId, fbPageId } = plan;
  const cbo = campaign.budgetMode === 'CAMPAIGN';
  // RESUME POINT: an unfinished build's Facebook campaign. Only a real launch (it has a recorder)
  // picks one up; a test launch always builds a fresh structure and ignores whatever is recorded.
  const resumeCampaignId = recorder ? campaign.fbPendingCampaignId : null;
  // Audit which FB app published this campaign (DATA vs the LAUNCH app) — so every launch
  // is verifiable from the logs without inspecting tokens.
  console.log(
    resumeCampaignId
      ? `[launch] resuming FB structure ${resumeCampaignId} for campaign ${campaign.id} via the ${appKind} app (act_${fbAccountId}) — skipping what is already on Facebook`
      : `[launch] building FB structure for campaign ${campaign.id} via the ${appKind} app (act_${fbAccountId})`,
  );
  // Catch a launch-app asset-grant gap BEFORE creating any FB objects (no orphans).
  await assertLaunchAssetsAccessible(plan);
  // Rotate onto a redirect domain from the buyer's eligible pool (mode-segregated, company-isolated).
  // A resumed build stays on the host its already-created ads link to.
  const funnelMode = await resolveBuyerFunnelMode(campaign.orgId, campaign.buyerId);
  const { base: redirectBase, host: redirectDomainHost } = await resolveRedirectBase(
    funnelMode,
    campaign.orgId,
    resumeCampaignId ? campaign.redirectDomainHost : null,
  );
  if (resumeCampaignId && campaign.redirectDomainHost && redirectDomainHost !== campaign.redirectDomainHost) {
    // The host the earlier ads link to left its pool (retired / flagged) mid-build. The rest of the build
    // uses a fresh one, and only that one is recorded — say so, so the split is visible.
    console.warn(`[launch] resumed campaign ${campaign.id}: redirect host ${campaign.redirectDomainHost} is no longer eligible — the remaining ads link to ${redirectDomainHost}; the ads already created still link to the old host`);
  }

  // Automatic bidding (no cap → no bid_amount needed). The bid strategy lives at the
  // budget level: on the CAMPAIGN for CBO, on the AD SET for ABO — never both.
  let fbCampaignId = resumeCampaignId;
  if (!fbCampaignId) {
    const fbCampaign = await createFbCampaign(fbAccountId, token, {
      name: campaign.name,
      objective: campaign.objective,
      specialAdCategories: campaign.specialAdCategories,
      status,
      dailyBudgetCents: cbo ? campaign.dailyBudgetCents ?? undefined : undefined,
      bidStrategy: cbo ? 'LOWEST_COST_WITHOUT_CAP' : undefined,
    }, appKind);
    fbCampaignId = fbCampaign.id;
    await recorder?.campaign({ fbCampaignId, redirectDomainHost });
  }

  const adSets: FbStructureResult['adSets'] = [];
  for (const { set, fbPixelId, ads } of plan.adSets) {
    // A recorded ad set is only meaningful under the Facebook campaign it was created in, i.e. when
    // resuming: under a brand-new campaign it would belong to some other one and must be recreated.
    let fbAdSetId = resumeCampaignId ? set.fbAdSetId : null;
    const adSetResumed = fbAdSetId != null;
    if (!fbAdSetId) {
      // ODAX: a website conversion-location ad set carries destination_type WEBSITE; the
      // pixel promoted_object is sent ONLY for conversion goals that require it.
      const fbAdSet = await createFbAdSet(fbAccountId, token, {
        name: set.name,
        campaignId: fbCampaignId,
        optimizationGoal: set.optimizationGoal,
        billingEvent: set.billingEvent,
        dailyBudgetCents: cbo ? undefined : set.dailyBudgetCents ?? undefined,
        bidStrategy: cbo ? undefined : 'LOWEST_COST_WITHOUT_CAP',
        destinationType: WEBSITE_DESTINATION_GOALS.has(set.optimizationGoal) ? 'WEBSITE' : undefined,
        promotedObject:
          goalRequiresPixel(set.optimizationGoal) && fbPixelId
            ? { pixel_id: fbPixelId, custom_event_type: pxeToCustomEventType(set.pxeEvent) }
            : undefined,
        targeting: buildTargeting(set),
        startTime: set.startTime?.toISOString(),
        endTime: set.endTime?.toISOString(),
        status,
      }, appKind);
      fbAdSetId = fbAdSet.id;
      await recorder?.adSet({ adSetId: set.id, fbAdSetId });
    }

    const adResults: { id: string; fbAdId: string }[] = [];
    for (const { ad, storageKey, creativeKind, mimeType, filename } of ads) {
      // Already on Facebook from an earlier attempt (and its ad set was reused too): nothing to
      // read, upload or create — this is what makes a re-drive free of duplicates.
      if (adSetResumed && ad.fbAdId) {
        adResults.push({ id: ad.id, fbAdId: ad.fbAdId });
        continue;
      }
      if (!storageKey) throw new AppError(400, `Ad "${ad.name}" has no creative file`);
      const creativeNoun = creativeKind === 'VIDEO' ? 'video' : 'image';
      let bytes: Buffer;
      try {
        bytes = await readFile(join(env.UPLOAD_DIR, storageKey));
      } catch (err) {
        // The DB references a creative file that's no longer on disk (e.g. uploaded
        // before the uploads volume existed, or lost). Fail with an actionable message
        // instead of a raw 500 — the buyer must reopen the campaign and re-upload it.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          throw new AppError(409, `Ad "${ad.name}" — its creative ${creativeNoun} is missing on the server. Reopen the campaign, re-upload the ad's ${creativeNoun}, then relaunch.`);
        }
        throw err;
      }
      const destination = `${redirectBase}/go/${ad.redirectId}`;
      const callToAction = { type: ad.cta, value: { link: destination } };

      // VIDEO vs IMAGE creative — the bug this guards against: a video uploaded via the image path
      // (`adimages` base64) makes Facebook reject the launch with "We could not process the image
      // that you have uploaded." A video goes to `/advideos` and references `video_data.video_id`
      // (plus the auto-generated thumbnail FB requires); an image uses `link_data.image_hash`. The
      // click destination + `kaid` url_tag (so the cloaker can verify the ad id) are identical.
      let objectStorySpec: Record<string, unknown>;
      if (creativeKind === 'VIDEO') {
        const videoId = await uploadFbAdVideo(
          fbAccountId,
          token,
          { bytes, filename: filename ?? `${ad.name}.mp4`, mimeType: mimeType ?? 'video/mp4' },
          appKind,
        );
        // FB processes uploaded videos asynchronously — the thumbnail is often not ready the instant
        // the upload returns. Poll with backoff (~30s total) instead of failing on the first miss, so
        // a video ad doesn't get stuck in PROCESSING waiting for a manual relaunch.
        const thumbnailUrl = await pollForVideoThumbnail(videoId, token, appKind, fbAccountId);
        if (!thumbnailUrl) {
          throw new AppError(
            409,
            `Ad "${ad.name}" — Facebook is still processing your video after ~30s of retries. It may be a large or slow-processing file; wait a minute and relaunch.`,
          );
        }
        objectStorySpec = {
          page_id: fbPageId,
          video_data: {
            video_id: videoId,
            image_url: thumbnailUrl,
            // video_data field names differ from link_data: title=headline, message=primary text,
            // link_description=description. There's no top-level link/caption on video_data — the
            // cloaked /go destination rides the CTA link instead.
            ...(ad.primaryText ? { message: ad.primaryText } : {}),
            ...(ad.headline ? { title: ad.headline } : {}),
            ...(ad.description ? { link_description: ad.description } : {}),
            call_to_action: callToAction,
          },
        };
      } else {
        const imageHash = await uploadFbAdImage(fbAccountId, token, bytes.toString('base64'), appKind);
        // Display link (FB link_data.caption): the VISIBLE URL caption in the ad, separate from the
        // cloaked `link` destination. FB requires an actual URL, so normalize a bare domain to https://.
        // Unset → FB derives the display URL from the destination domain (prior behavior).
        // CLOAKER campaigns ALWAYS show the assigned white domain as the display link, so the visible ad
        // URL matches where a reviewer/organic visitor actually lands (the fallback → the white site).
        // Otherwise the buyer's own display link (normalized to a URL); unset → FB derives it.
        const displayCaption = campaign.whiteDomainHost
          ? `https://${campaign.whiteDomainHost}`
          : ad.displayLink
            ? /^https?:\/\//i.test(ad.displayLink)
              ? ad.displayLink
              : `https://${ad.displayLink}`
            : undefined;
        objectStorySpec = {
          page_id: fbPageId,
          link_data: {
            link: destination,
            // Headline (name) + primary text (message) are optional on FB — omit when empty.
            ...(ad.primaryText ? { message: ad.primaryText } : {}),
            ...(ad.headline ? { name: ad.headline } : {}),
            ...(ad.description ? { description: ad.description } : {}),
            ...(displayCaption ? { caption: displayCaption } : {}),
            image_hash: imageHash,
            call_to_action: callToAction,
          },
        };
      }
      const creative = await createFbAdCreative(fbAccountId, token, {
        name: ad.name,
        objectStorySpec,
        // FB substitutes {{ad.id}} at click time → `/go/{redirectId}?…&kaid=<fbAdId>`, which the
        // cloaker verifies against the ad's stored fbAdId (observe-first; see syncCampaignRedirectConfigs).
        urlTags: 'kaid={{ad.id}}',
      }, appKind);
      const fbAd = await createFbAd(fbAccountId, token, {
        name: ad.name,
        adSetId: fbAdSetId,
        creativeId: creative.id,
        status,
      }, appKind);
      await recorder?.ad({ adId: ad.id, fbAdId: fbAd.id });
      adResults.push({ id: ad.id, fbAdId: fbAd.id });
    }
    adSets.push({ id: set.id, fbAdSetId, ads: adResults });
  }

  return { fbCampaignId, fbAccountId, adSets, redirectDomainHost };
}

/**
 * The recorder for a real launch: writes each Facebook id to its row in its own small transaction,
 * right after the Graph call that created it. This is the ONLY window that can still orphan an
 * object (Facebook created it but the write failed — a DB outage), so it logs the id loudly before
 * rethrowing: an operator can then pause it by hand instead of it being lost.
 */
function fbBuildRecorder(auth: AuthContext, campaignId: string, fbAccountId: string): FbBuildRecorder {
  const record = async (what: string, fbId: string, write: (tx: TxClient) => Promise<unknown>): Promise<void> => {
    try {
      await runScoped(auth, write);
    } catch (err) {
      console.error(
        `[launch] ORPHAN RISK: created FB ${what} ${fbId} (act_${fbAccountId}) for campaign ${campaignId} but could not record it: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  };
  return {
    campaign: ({ fbCampaignId, redirectDomainHost }) =>
      record('campaign', fbCampaignId, async (tx) => {
        await tx.campaign.update({ where: { id: campaignId }, data: { fbPendingCampaignId: fbCampaignId, fbAccountId, redirectDomainHost } });
        // A brand-new Facebook campaign cannot own ad sets/ads that were recorded against another one.
        await tx.adSet.updateMany({ where: { campaignId, fbAdSetId: { not: null } }, data: { fbAdSetId: null } });
        await tx.ad.updateMany({ where: { adSet: { campaignId }, fbAdId: { not: null } }, data: { fbAdId: null } });
      }),
    adSet: ({ adSetId, fbAdSetId }) =>
      record('ad set', fbAdSetId, async (tx) => {
        await tx.adSet.update({ where: { id: adSetId }, data: { fbAdSetId } });
        await tx.ad.updateMany({ where: { adSetId, fbAdId: { not: null } }, data: { fbAdId: null } }); // same reason, one level down
      }),
    ad: ({ adId, fbAdId }) => record('ad', fbAdId, (tx) => tx.ad.update({ where: { id: adId }, data: { fbAdId } })),
  };
}

/**
 * Write a finished structure's ids in one go: `fb_campaign_id` (the "fully built" marker), every ad
 * set / ad id, and the in-progress `fb_pending_campaign_id` cleared. Used by the TEST launch, which has
 * no recorder; a real launch has already committed each child id as it was created, so it writes only
 * the campaign-level marker (together with the status) in its completion commit.
 */
async function writeFbIds(tx: TxClient, campaignId: string, result: FbStructureResult): Promise<void> {
  await tx.campaign.update({
    where: { id: campaignId },
    data: { fbCampaignId: result.fbCampaignId, fbAccountId: result.fbAccountId, fbPendingCampaignId: null },
  });
  for (const s of result.adSets) {
    await tx.adSet.update({ where: { id: s.id }, data: { fbAdSetId: s.fbAdSetId } });
    for (const a of s.ads) await tx.ad.update({ where: { id: a.id }, data: { fbAdId: a.fbAdId } });
  }
}

/** Persist the returned FB ids onto the campaign/adsets/ads. */
async function persistFbIds(auth: AuthContext, campaignId: string, result: FbStructureResult): Promise<void> {
  await runScoped(auth, (tx) => writeFbIds(tx, campaignId, result));
}

/**
 * Test-launch (stopgap, task #14): push a complete campaign to Facebook in PAUSED
 * state with the per-ad redirect URL as the destination, to validate the write-path.
 */
export async function testLaunchCampaign(auth: AuthContext, campaignId: string): Promise<TestLaunchResult> {
  const plan = await resolveLaunchPlan(auth, campaignId);
  // A real launch left objects on Facebook that this campaign still owns: a fresh PAUSED test structure
  // would take over `fb_campaign_id` and orphan them (live, spending). Finish or discard that build first.
  if (plan.campaign.fbPendingCampaignId) {
    throw new AppError(409, 'This campaign has an unfinished launch on Facebook — finish it (Launch) or reopen the campaign before running a test launch.');
  }
  const result = await createFbStructure(plan, 'PAUSED');
  await persistFbIds(auth, campaignId, result);
  return result;
}

export interface LaunchDeps {
  generateArticle: (auth: AuthContext, campaignId: string) => Promise<{ slug: string }>;
  writeRedirectConfigs: (entries: { redirectId: string; config: RedirectConfigPayload }[]) => Promise<void>;
  /** Test seam for the Whop launch, which waits between tries (pixel preflight, creative processing). Unused by Facebook. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the Whop launch: how a finished launch is saved. Unused by Facebook. */
  saveLaunched?: WhopLaunchDeps['saveLaunched'];
  /** Test seam for resume: asks the worker to give the resumed campaign its channel(s) back. Defaults to the real queue. */
  requestChannels?: (campaignId: string) => Promise<void>;
}
const defaultLaunchDeps: LaunchDeps = {
  generateArticle: (auth, id) => generateArticleForCampaign(auth, id),
  writeRedirectConfigs,
};

export interface LaunchResult {
  status: 'ACTIVE' | 'BATCHED';
  fbCampaignId?: string;
  /** Whop campaigns only (D33). */
  whopCampaignId?: string;
}

/**
 * The real launch pipeline (Phase 8). For an approved campaign that already has a
 * channel (Phase 6): ensure its article (Phase 5) → write each ad's redirect config
 * to edge KV (Phase 7) → create the Campaign→AdSet→Ad on Facebook **ACTIVE** through
 * the rate-limited client (D12) → ACTIVE + notify. An FB rate-limit parks it in
 * BATCHED for a later retry. Idempotent: a campaign already launched (fbCampaignId)
 * is returned as ACTIVE.
 *
 * RESUMABLE: the build records every Facebook id the moment its object exists
 * (`fb_pending_campaign_id`, `ad_sets.fb_ad_set_id`, `ads.fb_ad_id`), and the next attempt — the
 * buyer's manual Launch, auto-launch, or the BATCHED re-drive — skips what is already on Facebook
 * and creates only the rest. So a rate limit (or any failure) part-way through never leaves live
 * objects with no id, and a retry never duplicates. `fb_campaign_id` is written only when the whole
 * structure is built, in the same commit that flips the status to ACTIVE. A failure that is NOT a
 * rate limit is still never retried automatically (D19): it reverts to PROCESSING for a human.
 */
export async function launchCampaign(
  auth: AuthContext,
  campaignId: string,
  deps: LaunchDeps = defaultLaunchDeps,
): Promise<LaunchResult> {
  const campaign = await runScoped(auth, async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId }, include: campaignInclude });
    if (!c) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && c.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
    return c;
  });

  // Whop has its own launch (D33): draft-first, resumable, and it checks the pixel at the end of our go-link.
  if (campaign.adProvider === 'WHOP') return launchWhopCampaign(auth, campaign, deps);

  if (campaign.fbCampaignId) return { status: 'ACTIVE', fbCampaignId: campaign.fbCampaignId };

  // A campaign routes its traffic across PAID offers (Phase E) — each offer's website +
  // its own AFS channel — or, legacy, a single channel + the platform article domain.
  const offers = await runScoped(auth, (tx) =>
    tx.offer.findMany({ where: { campaignId }, include: { domain: { select: { host: true } } } }),
  );
  const paidOffers = offers.filter((o) => o.kind === 'PAID');
  if (paidOffers.length > 0) {
    if (paidOffers.some((o) => !o.channelRef)) throw new AppError(409, 'Offers have no channels assigned yet');
  } else if (!campaign.channelId) {
    throw new AppError(409, 'Campaign has no channel assigned yet');
  }

  // 1. Ensure the article exists; get its slug.
  let slug: string;
  if (campaign.articleId) {
    const article = await runScoped(auth, (tx) =>
      tx.article.findUnique({ where: { id: campaign.articleId! }, select: { slug: true } }),
    );
    if (!article) throw new AppError(409, 'Campaign article is missing');
    slug = article.slug;
  } else {
    slug = (await deps.generateArticle(auth, campaignId)).slug;
  }

  // 2. Resolve the routing: offer splits (each offer's website host + its own AFS channel)
  //    for an offers campaign, or the single legacy channel + the platform article domain.
  let articleUrl = `${env.ARTICLE_DOMAIN}/a/${slug}`;
  let channel: string | undefined;
  let splits: RedirectConfigPayload['splits'];
  let organicFallbackUrl: string | undefined;

  if (paidOffers.length > 0) {
    const chRows = await runScoped(auth, (tx) =>
      tx.channel.findMany({ where: { id: { in: paidOffers.map((o) => o.channelRef!) } }, select: { id: true, channelId: true } }),
    );
    const chById = new Map(chRows.map((c) => [c.id, c.channelId]));
    // Per-offer ARTICLE VARIANT (A/B): each offer may serve its own article; otherwise the
    // campaign's default. Resolve all variant slugs up front (fall back to the campaign slug
    // if a variant was removed since it was set).
    const variantIds = [...new Set(offers.map((o) => o.articleId).filter((x): x is string => Boolean(x)))];
    const variantRows = variantIds.length
      ? await runScoped(auth, (tx) => tx.article.findMany({ where: { id: { in: variantIds } }, select: { id: true, slug: true } }))
      : [];
    const slugByArticle = new Map(variantRows.map((a) => [a.id, a.slug]));
    const slugFor = (articleId: string | null): string => (articleId ? slugByArticle.get(articleId) ?? slug : slug);
    splits = paidOffers.map((o) => ({
      url: withCustomTerms(`https://${o.domain.host}/a/${slugFor(o.articleId)}`, campaign.termsOverride),
      weight: o.weightPct,
      channel: chById.get(o.channelRef!),
      offerId: o.id,
    }));
    // The ORGANIC offer (if configured) is where non-ad traffic goes (its own variant too).
    const organic = offers.find((o) => o.kind === 'ORGANIC');
    organicFallbackUrl = organic ? `https://${organic.domain.host}/a/${slugFor(organic.articleId)}` : undefined;
    // articleUrl is only a safety net when splits is empty (it isn't here); point at the
    // first offer so a malformed config still lands on a monetized page.
    articleUrl = splits[0]?.url ?? articleUrl;
  } else {
    const channelRow = await runScoped(auth, (tx) =>
      tx.channel.findUnique({ where: { id: campaign.channelId! }, select: { channelId: true } }),
    );
    channel = channelRow?.channelId;
    articleUrl = withCustomTerms(articleUrl, campaign.termsOverride);
  }

  // CLOAKER buyers: auto-assign a rotated white domain — the FB display link + the (white) fallback
  // page that organic/bot/reviewer traffic sees. The buyer never sets these. Recorded on the campaign
  // so the post-launch resync AND the FB creative (createFbStructure) read the SAME white host.
  const funnelMode = await resolveBuyerFunnelMode(campaign.orgId, campaign.buyerId);
  // Resuming an unfinished build: keep the white domain its already-created ads display (their FB
  // display link can't change), so the visible ad URL still matches the fallback page.
  const whiteHost = funnelMode === 'CLOAKER'
    ? await pickWhiteDomain(campaign.fbPendingCampaignId ? campaign.whiteDomainHost : null)
    : undefined;
  if (campaign.fbPendingCampaignId && campaign.whiteDomainHost && whiteHost !== campaign.whiteDomainHost) {
    console.warn(`[launch] resumed campaign ${campaignId}: white domain ${campaign.whiteDomainHost} is no longer in the pool — the remaining ads display ${whiteHost ?? 'no white domain'}; the ads already created still display the old one`);
  }
  const whiteFallbackUrl = whiteHost ? `https://${whiteHost}/a/${slug}` : undefined;
  await runScoped(auth, (tx) => tx.campaign.update({ where: { id: campaignId }, data: { whiteDomainHost: whiteHost ?? null } }));

  // 3. Write each ad's redirect config to edge KV (so go.* resolves once ads go live).
  const entries = campaign.adSets.flatMap((set) =>
    set.ads.map((ad) => ({
      redirectId: ad.redirectId,
      config: {
        campaignId: campaign.id,
        active: true,
        articleUrl,
        channel,
        splits,
        expectedAdId: ad.fbAdId ?? undefined,
        // referrerAdCreative (AFS `rc`): the ad's own override, else the campaign default (D27).
        adCreative: effectiveRac(ad.racValue, campaign.racValue) ?? undefined,
        // CLOAKER: white domain is the fallback (white page); else organic offer → ad → campaign.
        fallbackUrl: whiteFallbackUrl ?? organicFallbackUrl ?? ad.fallbackUrl ?? campaign.fallbackUrl ?? undefined,
      } satisfies RedirectConfigPayload,
    })),
  );
  try {
    await deps.writeRedirectConfigs(entries);
  } catch (err) {
    // Unconfigured CF is tolerated (redirect falls back until synced); real KV
    // failures should fail the launch (clicks would otherwise hit the fallback).
    if (err instanceof KvNotConfiguredError) {
      console.warn(`[launch] Cloudflare KV not configured — redirect configs not synced for ${campaignId}`);
    } else {
      throw err;
    }
  }

  // 4. Atomically CLAIM the launch → LAUNCHING, then create on FB → ACTIVE (or BATCHED on rate limit).
  // SINGLE-WRITER GUARD (D11): two triggers can fire for one campaign — auto-launch (worker) AND a
  // manual "Launch" click, or a retry. The `fbCampaignId` null-check at the top is check-then-act with
  // no lock, so two concurrent calls both passed it and each created a SEPARATE Facebook campaign (one
  // left orphaned + still spending — the duplicate-launch bug). This conditional UPDATE flips
  // PROCESSING/BATCHED → LAUNCHING only while no FB campaign exists; Postgres row-locks serialize
  // concurrent claims, so exactly one call wins and the loser bails out HERE — before createFbStructure
  // — without creating a duplicate. (Article gen + KV above ran while still PROCESSING, so a failure
  // there never leaves the campaign stuck in LAUNCHING.)
  const claim = await runScoped(auth, (tx) =>
    tx.campaign.updateMany({
      where: { id: campaignId, fbCampaignId: null, status: { in: [CAMPAIGN_STATUS.PROCESSING, CAMPAIGN_STATUS.BATCHED] } },
      data: { status: CAMPAIGN_STATUS.LAUNCHING },
    }),
  );
  if (claim.count === 0) {
    // Lost the race (or not in a launchable state). If the winner already finished, return ITS id;
    // otherwise a launch is in flight — never create a second FB campaign.
    const cur = await runScoped(auth, (tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { fbCampaignId: true } }));
    if (cur?.fbCampaignId) return { status: 'ACTIVE', fbCampaignId: cur.fbCampaignId };
    throw new AppError(409, 'This campaign is already being launched — give it a moment.');
  }

  let plan: LaunchPlan | undefined;
  try {
    plan = await resolveLaunchPlan(auth, campaignId);
    const resumed = Boolean(plan.campaign.fbPendingCampaignId); // continuing an earlier, interrupted build
    const result = await createFbStructure(plan, 'ACTIVE', fbBuildRecorder(auth, campaignId, plan.fbAccountId));
    // ONE commit: the structure is complete → record it as such (`fb_campaign_id` ← the campaign, pending
    // cleared) and go ACTIVE. The ad set / ad ids need no rewrite — the recorder committed each one as it was created.
    await runScoped(auth, async (tx) => {
      await tx.campaign.update({
        where: { id: campaignId },
        data: {
          fbCampaignId: result.fbCampaignId,
          fbAccountId: result.fbAccountId,
          fbPendingCampaignId: null,
          status: CAMPAIGN_STATUS.ACTIVE,
          redirectDomainHost: result.redirectDomainHost ?? undefined,
        },
      });
      await writeAudit(tx, {
        orgId: campaign.orgId,
        actorId: auth.userId,
        action: 'campaign.launched',
        entityType: 'campaign',
        entityId: campaignId,
        details: { fbCampaignId: result.fbCampaignId, resumed },
      });
    });
    // RE-SYNC the redirect configs now that the ad ids exist. Step 3 (above) wrote them BEFORE the FB
    // ads were created, so `ad.fbAdId` was null and `expectedAdId` came out empty — which is why the
    // cloak ad-id check (kaid={{ad.id}}) has nothing to match. persistFbIds just stored the real ids,
    // and syncCampaignRedirectConfigs reloads the campaign fresh, so this write carries `expectedAdId`
    // = the FB ad id (and active:true). REQUIRED for `CLOAK_VERIFY_MODE=enforce` to gate on the ad id.
    // Best-effort: the campaign is already live on Facebook — a KV hiccup must not fail the launch; a
    // later resync (resume/rebalance) heals it. (The launch is still ACTIVE either way.)
    await syncCampaignRedirectConfigs(campaignId, { writeRedirectConfigs: deps.writeRedirectConfigs }).catch((e) =>
      console.warn(
        `[launch] post-launch redirect resync (expectedAdId) failed for ${campaignId}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    await notify({
      orgId: campaign.orgId,
      userId: campaign.buyerId,
      type: 'campaign.live',
      title: 'Campaign is live',
      body: `"${campaign.name}" is now live on Facebook.`,
    });
    return { status: 'ACTIVE', fbCampaignId: result.fbCampaignId };
  } catch (err) {
    // Always log the FB error detail (code/subcode/fbtrace) — this was previously lost,
    // making restrictions impossible to diagnose from the logs.
    if (err instanceof FbApiError) {
      console.error(
        `[launch] Facebook error on campaign ${campaignId}: code=${err.code ?? '?'} subcode=${err.subcode ?? '?'} fbtrace=${err.fbtraceId ?? '?'} :: ${err.message}`,
      );
    }

    if (err instanceof FbRateLimitError) {
      await runScoped(auth, (tx) =>
        tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.BATCHED } }),
      );
      // Everything created before the limit hit is already recorded — the next attempt resumes it.
      console.warn(`[launch] Facebook rate-limited campaign ${campaignId} mid-build — parked in BATCHED; what is already on Facebook is recorded and the next attempt resumes it`);
      return { status: 'BATCHED' };
    }

    // Everything below reverts LAUNCHING → PROCESSING so the campaign isn't stuck and can
    // be relaunched once the underlying issue is fixed.
    await runScoped(auth, (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.PROCESSING } }),
    ).catch(() => undefined);
    // B1: launch wrote the edge KV with active:true BEFORE the FB build; the build failed, so roll
    // the config back to active:false (status is now PROCESSING) — otherwise residual paid clicks
    // keep hitting the monetized page with no live FB ads behind them. Best-effort.
    await syncCampaignRedirectConfigs(campaignId, { writeRedirectConfigs: deps.writeRedirectConfigs }).catch(() => undefined);

    // Ad-account security/policy hold (FB code 368 "authenticate your account in Ads
    // Manager"). The token is fine and existing ads keep running — only create/modify is
    // blocked until the OWNER re-authenticates in Ads Manager. Do NOT auto-retry (retries
    // make the checkpoint worse): notify, then surface a clear, actionable 409.
    if (err instanceof FbAccountRestrictedError) {
      const detail = err.userMessage ?? err.message;
      await notify({
        orgId: campaign.orgId,
        userId: campaign.buyerId,
        type: 'fb_account_restricted',
        title: 'Facebook needs you to authenticate your ad account',
        body: `"${campaign.name}" couldn't launch: Facebook has temporarily restricted this ad account for security. The account owner must open Ads Manager and complete "Authenticate your account" (a 6-digit code is emailed). Existing ads keep running. Then relaunch.`,
      }).catch(() => undefined);
      throw new AppError(
        409,
        'Facebook has temporarily restricted this ad account for security ("authenticate your account in Ads Manager"). The account owner must open Ads Manager and complete the authentication prompt (Facebook emails a 6-digit code), then relaunch. Existing ads keep running.' +
        (err.checkpointUrl ? ` Authenticate here: ${err.checkpointUrl}` : '') +
        (detail ? ` (Facebook: ${detail})` : ''),
      );
    }

    // Token break (err 190 / token subcodes) — flip the connection to CONNECTION_BROKEN
    // (D13: polling/launches stop until reconnect) + clear reconnect message.
    if (err instanceof FbConnectionBrokenError) {
      if (plan?.connectionId) await markConnectionBroken(plan.connectionId, err.message).catch(() => undefined);
      throw new AppError(409, 'This Facebook connection has expired or been revoked — reconnect the profile in Settings → Facebook, then relaunch.');
    }

    // A LAUNCH-app create that still failed on an asset/permission rejection (e.g. "the ad
    // account and pixel don't match", a Page-permission error) — almost always the short-lived
    // launch token isn't granted the same asset as the main connection. Rewrite FB's cryptic
    // message into an actionable one. Scoped to asset/permission keywords so an unrelated error
    // (e.g. a bad objective) still surfaces verbatim.
    if (
      plan?.appKind === 'LAUNCH' &&
      err instanceof FbApiError &&
      /pixel|page|ad ?account|permission|belong|different|access|not.*(eligible|match)/i.test(err.message)
    ) {
      throw new AppError(
        409,
        `Facebook rejected the launch with your launch app: "${err.message}". This usually means the launch app isn't granted the same ad account, Page or pixel as your main connection. Reconnect it (Settings → Facebook → Connect launch app), grant it the SAME assets, then relaunch.`,
      );
    }

    // Any other failure (FB rejection, creative/pixel error, …): rethrow for the UI.
    throw err;
  }
}

/** Where + how to talk to Facebook about a campaign's ad account: its Meta id and the WRITE credential. */
interface FbWriteTarget {
  fbAccountId: string;
  token: string;
  appKind: FbAppKind;
  connectionId: string;
}

/**
 * Resolve the FB write target for a campaign's ad account, inside the caller's transaction. The
 * credential is `resolveWriteAuth`'s — the owner's LAUNCH-app token when they have one (a DATA-token
 * write can trip the very checkpoint the LAUNCH app exists to clear), else DATA/VERIFY — and it throws
 * the usual actionable 409 when the connection is broken or expired. `null` when the ad account is no
 * longer connected (its row is gone): there is nothing to sign a call with.
 */
async function resolveFbWriteTarget(tx: TxClient, adAccountId: string | null): Promise<FbWriteTarget | null> {
  if (!adAccountId) return null;
  const acc = await tx.fbAdAccount.findUnique({
    where: { id: adAccountId },
    select: {
      fbAccountId: true,
      connection: { select: { id: true, userId: true, fbUserId: true, accessTokenEnc: true, status: true, appKind: true, tokenExpiresAt: true } },
    },
  });
  if (!acc) return null;
  const writeAuth = await resolveWriteAuth(tx, acc.connection);
  return { fbAccountId: acc.fbAccountId, token: writeAuth.token, appKind: writeAuth.appKind, connectionId: writeAuth.connectionId };
}

/** The previous Facebook campaign could not be paused: tell the buyer its id, so a live campaign is never left behind unnoticed. */
async function notifyFbCampaignNotPaused(
  c: { orgId: string; buyerId: string; name: string },
  fbCampaignId: string,
  what: 'reopened for editing' | 'relaunched',
): Promise<void> {
  await notify({
    orgId: c.orgId,
    userId: c.buyerId,
    type: 'campaign.fb_build_not_paused',
    title: 'A Facebook campaign may still be running',
    body: `"${c.name}" was ${what}, but its previous Facebook campaign (${fbCampaignId}) could not be paused automatically. Pause it in Ads Manager so it stops spending.`,
  });
}

/**
 * Force a relaunch of an already-launched campaign: pause the existing FB campaign (so its
 * stale ads stop delivering), clear the stored FB ids + reset to PROCESSING, then re-run
 * launchCampaign to re-create Campaign→AdSet→Ad on Facebook with the CURRENT config —
 * notably a corrected `REDIRECT_DOMAIN`/creative link. Used when a live campaign's creatives
 * carry a stale/broken redirect domain. The old FB campaign is left PAUSED (no spend), and a
 * fresh FB campaign is created. A launch that never finished (its Facebook campaign is only in
 * `fb_pending_campaign_id`) is treated the same: paused and forgotten, then rebuilt from scratch —
 * relaunch is the explicit "start over", whereas a plain launch resumes.
 */
export async function relaunchCampaign(auth: AuthContext, campaignId: string, deps: LaunchDeps = defaultLaunchDeps): Promise<LaunchResult> {
  if ((await campaignProvider(auth, campaignId)) === 'WHOP') return relaunchWhopCampaign(auth, campaignId, deps);
  // Resolve the current FB campaign + the write credential to pause its delivery (best-effort).
  const info = await runScoped(auth, async (tx) => {
    const c = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, buyerId: true, orgId: true, name: true, fbCampaignId: true, fbPendingCampaignId: true, adAccountId: true },
    });
    if (!c) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && c.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
    // The finished campaign, or — for a launch that never finished — the unfinished one (also live).
    const oldFbCampaignId = c.fbCampaignId ?? c.fbPendingCampaignId;
    return { c, oldFbCampaignId, target: oldFbCampaignId ? await resolveFbWriteTarget(tx, c.adAccountId) : null };
  });

  // Stop the old (stale-link) campaign on Facebook. Best-effort — never block the relaunch — but never
  // silent: when it can't be paused the buyer is told its id, so a live campaign isn't left behind unnoticed.
  if (info.oldFbCampaignId) {
    let paused = false;
    if (info.target) {
      try {
        await updateFbCampaignStatus(info.oldFbCampaignId, info.target.fbAccountId, info.target.token, 'PAUSED', info.target.appKind);
        paused = true;
      } catch (err) {
        console.warn(`[relaunch] could not pause old FB campaign for ${campaignId}: ${(err as Error).message}`);
      }
    }
    if (!paused) await notifyFbCampaignNotPaused(info.c, info.oldFbCampaignId, 'relaunched');
  }

  // Clear the stored FB ids (finished AND unfinished) + reset to PROCESSING so launchCampaign
  // re-creates the whole structure instead of resuming the old one.
  await runScoped(auth, async (tx) => {
    await tx.ad.updateMany({ where: { adSet: { campaignId } }, data: { fbAdId: null } });
    await tx.adSet.updateMany({ where: { campaignId }, data: { fbAdSetId: null } });
    await tx.campaign.update({ where: { id: campaignId }, data: { fbCampaignId: null, fbPendingCampaignId: null, status: CAMPAIGN_STATUS.PROCESSING } });
  });

  return launchCampaign(auth, campaignId, deps);
}

/**
 * Abandon a launch's UNFINISHED Facebook structure so the campaign can be reopened for editing.
 *
 * Why this exists: a resumed launch reuses every object it already created, which is only right
 * while the campaign's config is unchanged. "Reopen & edit" is exactly the moment it changes — and
 * the objects built so far may be live and spending. So before the reopen we pause the unfinished
 * Facebook campaign and forget every recorded id; the next launch then builds the edited config from
 * scratch. Pausing comes first and the ids are dropped only after it worked, so a failure never
 * strands a live campaign with no record of it.
 *
 * Failure policy (mirrors pause/resume and the budget edits): a rate limit, an ad-account security
 * hold or a dead token stops the reopen with the usual actionable error and changes nothing — the
 * buyer can retry once it clears. Anything else Facebook says (typically: the campaign was deleted
 * in Ads Manager, so there is nothing left to pause) — or an ad account that is no longer connected —
 * cannot be fixed by waiting, so the reopen goes ahead and the buyer is told to pause it by hand.
 * A no-op (returns false) unless the campaign has an unfinished build and can be reopened.
 *
 * Not atomic with a concurrent launch: if one claims the campaign while we are pausing its Facebook
 * campaign, the guarded clear below matches nothing and the reopen stops (409) — and that launch then
 * resumes a campaign that is paused on Facebook. The 30-minute status reconcile mirrors it as PAUSED
 * and the buyer can resume it (no spend is lost, nothing duplicates).
 */
async function discardUnfinishedFbBuild(auth: AuthContext, campaignId: string): Promise<boolean> {
  const found = await runScoped(auth, async (tx) => {
    const c = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true, buyerId: true, orgId: true, name: true, status: true,
        fbCampaignId: true, fbPendingCampaignId: true, adAccountId: true,
        adSets: { select: { fbAdSetId: true, ads: { select: { fbAdId: true } } } },
      },
    });
    if (!c) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && c.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
    // Only a campaign that CAN be reopened is touched (otherwise reopenCampaign reports the state
    // error in its usual words), and only while a build is unfinished.
    if (c.fbCampaignId || !c.fbPendingCampaignId || !canTransitionCampaign(c.status, CAMPAIGN_STATUS.DRAFT)) return null;

    return {
      orgId: c.orgId,
      buyerId: c.buyerId,
      name: c.name,
      status: c.status,
      pendingId: c.fbPendingCampaignId,
      adSets: c.adSets.filter((s) => s.fbAdSetId).length,
      ads: c.adSets.reduce((n, s) => n + s.ads.filter((a) => a.fbAdId).length, 0),
      fb: await resolveFbWriteTarget(tx, c.adAccountId),
    };
  });
  if (!found) return false;

  let paused = false;
  if (found.fb) {
    try {
      await updateFbCampaignStatus(found.pendingId, found.fb.fbAccountId, found.fb.token, 'PAUSED', found.fb.appKind);
      paused = true;
    } catch (err) {
      if (err instanceof FbRateLimitError || err instanceof FbAccountRestrictedError || err instanceof FbConnectionBrokenError) {
        await throwFbWriteError(err, found.fb.connectionId); // always throws
      }
      console.warn(`[reopen] could not pause unfinished FB campaign ${found.pendingId} for ${campaignId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Forget the unfinished structure — only if nothing moved while we talked to Facebook.
  await runScoped(auth, async (tx) => {
    const cleared = await tx.campaign.updateMany({
      where: { id: campaignId, fbCampaignId: null, fbPendingCampaignId: found.pendingId, status: found.status },
      data: { fbPendingCampaignId: null },
    });
    if (cleared.count === 0) throw new AppError(409, 'This campaign changed while it was being reopened — try again.');
    await tx.adSet.updateMany({ where: { campaignId }, data: { fbAdSetId: null } });
    await tx.ad.updateMany({ where: { adSet: { campaignId } }, data: { fbAdId: null } });
    await writeAudit(tx, {
      orgId: found.orgId,
      actorId: auth.userId,
      action: 'campaign.fb_build_discarded',
      entityType: 'campaign',
      entityId: campaignId,
      details: { fbCampaignId: found.pendingId, adSets: found.adSets, ads: found.ads, pausedOnFacebook: paused },
    });
  });

  if (!paused) await notifyFbCampaignNotPaused(found, found.pendingId, 'reopened for editing');
  return true;
}

/**
 * Reopen a pre-launch campaign to an editable DRAFT — the campaign page's "Reopen & edit". Same as
 * `reopenCampaign`, but first abandons any UNFINISHED Facebook structure (see `discardUnfinishedFbBuild`)
 * so the edited campaign is never launched by resuming objects built from its old config. This is the
 * entry point the reopen route uses; `reopenCampaign` alone refuses a campaign with an unfinished build.
 */
export async function reopenCampaignForEdit(auth: AuthContext, campaignId: string): Promise<CampaignWithChildren> {
  const discarded = await discardUnfinishedFbBuild(auth, campaignId);
  const reopened = await reopenCampaign(auth, campaignId);
  // B1: the unfinished build's edge configs were written active:true with the channel that reopening just
  // released — and its ads may still be live — so they would keep routing paid clicks to a channel another
  // campaign is about to be given. The campaign is DRAFT now, so this republishes them inactive. Best-effort:
  // a KV hiccup must never fail a reopen that has already happened.
  if (discarded) {
    await syncCampaignRedirectConfigs(campaignId).catch((e) =>
      console.warn(`[reopen] edge KV resync failed for ${campaignId}:`, e instanceof Error ? e.message : String(e)),
    );
  }
  return reopened;
}