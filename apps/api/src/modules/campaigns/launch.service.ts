import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '@knn/config';
import { FbConnectionStatus, type TxClient, withSystem } from '@knn/db';
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
  hasLaunchApp,
  updateFbAdSetBudget,
  updateFbCampaignBudget,
  updateFbCampaignStatus,
  uploadFbAdImage,
} from '@knn/fb';
import { CAMPAIGN_STATUS, ROLES, WEBSITE_DESTINATION_GOALS, campaignSubmitIssues, goalRequiresPixel, pxeToCustomEventType } from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { KvNotConfiguredError, type RedirectConfigPayload, writeRedirectConfigs } from '../../lib/kv-sync.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { markConnectionBroken } from '../facebook/facebook.service.js';
import { generateArticleForCampaign } from '../articles/articles.service.js';
import { type CampaignWithChildren, campaignInclude, toDraft } from './campaigns.service.js';

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
    const launch = await tx.fbConnection.findFirst({
      where: { userId: dataConn.userId, appKind: 'LAUNCH' },
      orderBy: { tokenExpiresAt: 'desc' },
      select: { id: true, accessTokenEnc: true, tokenExpiresAt: true, status: true },
    });
    if (launch) {
      if (launch.status === FbConnectionStatus.CONNECTION_BROKEN || launch.tokenExpiresAt.getTime() <= Date.now()) {
        throw new AppError(
          409,
          'Your Facebook launch-app connection needs reconnecting — open Settings → Facebook → Connect launch app, then relaunch.',
        );
      }
      return { token: decryptConnectionToken(launch.accessTokenEnc), appKind: 'LAUNCH', connectionId: launch.id };
    }
  }
  if (dataConn.status === FbConnectionStatus.CONNECTION_BROKEN) {
    throw new AppError(409, 'Facebook connection is broken — reconnect first');
  }
  return { token: decryptConnectionToken(dataConn.accessTokenEnc), appKind: 'DATA', connectionId: dataConn.id };
}

export interface FbStructureResult {
  fbCampaignId: string;
  adSets: { id: string; fbAdSetId: string; ads: { id: string; fbAdId: string }[] }[];
}
export type TestLaunchResult = FbStructureResult;

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
  adSets: { set: StoredAdSet; fbPixelId: string | null; ads: { ad: StoredAdSet['ads'][number]; storageKey: string | null }[] }[];
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
              ? await tx.upload.findUnique({ where: { id: ad.uploadId }, select: { storageKey: true } })
              : null;
            return { ad, storageKey: upload?.storageKey ?? null };
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
 * Pause or resume a launched campaign — the core optimization action. Flips the FB
 * campaign's delivery status (network call done OUTSIDE the txn) AND the local status
 * (ACTIVE ↔ PAUSED). A buyer may only touch their own; admins/super their scope (RLS).
 * Requires the campaign to be ACTIVE or PAUSED; a no-op if already in the target state.
 */
export async function setCampaignActive(
  auth: AuthContext,
  campaignId: string,
  active: boolean,
  deps: Pick<LaunchDeps, 'writeRedirectConfigs'> = { writeRedirectConfigs },
): Promise<{ id: string; status: string }> {
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
            : 'This campaign uses per-ad-set budgets across multiple ad sets — edit each ad set’s budget individually (coming soon).',
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
 * The base URL ad creatives link to: `https://{default redirect domain}`. Super-admin
 * manages these in the Redirect Domains panel; falls back to env `REDIRECT_DOMAIN` when
 * none is marked default (e.g. fresh install). The host must point at the edge Worker.
 */
async function resolveRedirectBase(): Promise<string> {
  const def = await withSystem((tx) => tx.redirectDomain.findFirst({ where: { isDefault: true }, select: { host: true } }));
  return def?.host ? `https://${def.host}` : env.REDIRECT_DOMAIN;
}

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

async function createFbStructure(plan: LaunchPlan, status: 'PAUSED' | 'ACTIVE'): Promise<FbStructureResult> {
  const { campaign, token, appKind, fbAccountId, fbPageId } = plan;
  const cbo = campaign.budgetMode === 'CAMPAIGN';
  // Audit which FB app published this campaign (DATA vs the LAUNCH app) — so every launch
  // is verifiable from the logs without inspecting tokens.
  console.log(`[launch] building FB structure for campaign ${campaign.id} via the ${appKind} app (act_${fbAccountId})`);
  // Catch a launch-app asset-grant gap BEFORE creating any FB objects (no orphans).
  await assertLaunchAssetsAccessible(plan);
  const redirectBase = await resolveRedirectBase();

  // Automatic bidding (no cap → no bid_amount needed). The bid strategy lives at the
  // budget level: on the CAMPAIGN for CBO, on the AD SET for ABO — never both.
  const fbCampaign = await createFbCampaign(fbAccountId, token, {
    name: campaign.name,
    objective: campaign.objective,
    specialAdCategories: campaign.specialAdCategories,
    status,
    dailyBudgetCents: cbo ? campaign.dailyBudgetCents ?? undefined : undefined,
    bidStrategy: cbo ? 'LOWEST_COST_WITHOUT_CAP' : undefined,
  }, appKind);

  const adSets: FbStructureResult['adSets'] = [];
  for (const { set, fbPixelId, ads } of plan.adSets) {
    // ODAX: a website conversion-location ad set carries destination_type WEBSITE; the
    // pixel promoted_object is sent ONLY for conversion goals that require it.
    const fbAdSet = await createFbAdSet(fbAccountId, token, {
      name: set.name,
      campaignId: fbCampaign.id,
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

    const adResults: { id: string; fbAdId: string }[] = [];
    for (const { ad, storageKey } of ads) {
      if (!storageKey) throw new AppError(400, `Ad "${ad.name}" has no creative file`);
      let bytes: Buffer;
      try {
        bytes = await readFile(join(env.UPLOAD_DIR, storageKey));
      } catch (err) {
        // The DB references a creative file that's no longer on disk (e.g. uploaded
        // before the uploads volume existed, or lost). Fail with an actionable message
        // instead of a raw 500 — the buyer must reopen the campaign and re-upload it.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          throw new AppError(409, `Ad "${ad.name}" — its creative image is missing on the server. Reopen the campaign, re-upload the ad's image, then relaunch.`);
        }
        throw err;
      }
      const imageHash = await uploadFbAdImage(fbAccountId, token, bytes.toString('base64'), appKind);
      const destination = `${redirectBase}/go/${ad.redirectId}`;
      // Display link (FB link_data.caption): the VISIBLE URL caption in the ad, separate from the
      // cloaked `link` destination. FB requires an actual URL, so normalize a bare domain to https://.
      // Unset → FB derives the display URL from the destination domain (prior behavior).
      const displayCaption = ad.displayLink
        ? /^https?:\/\//i.test(ad.displayLink)
          ? ad.displayLink
          : `https://${ad.displayLink}`
        : undefined;
      const creative = await createFbAdCreative(fbAccountId, token, {
        name: ad.name,
        objectStorySpec: {
          page_id: fbPageId,
          link_data: {
            link: destination,
            // Headline (name) + primary text (message) are optional on FB — omit when empty.
            ...(ad.primaryText ? { message: ad.primaryText } : {}),
            ...(ad.headline ? { name: ad.headline } : {}),
            ...(ad.description ? { description: ad.description } : {}),
            ...(displayCaption ? { caption: displayCaption } : {}),
            image_hash: imageHash,
            call_to_action: { type: ad.cta, value: { link: destination } },
          },
        },
      }, appKind);
      const fbAd = await createFbAd(fbAccountId, token, {
        name: ad.name,
        adSetId: fbAdSet.id,
        creativeId: creative.id,
        status,
      }, appKind);
      adResults.push({ id: ad.id, fbAdId: fbAd.id });
    }
    adSets.push({ id: set.id, fbAdSetId: fbAdSet.id, ads: adResults });
  }

  return { fbCampaignId: fbCampaign.id, adSets };
}

/** Persist the returned FB ids onto the campaign/adsets/ads. */
async function persistFbIds(auth: AuthContext, campaignId: string, result: FbStructureResult): Promise<void> {
  await runScoped(auth, async (tx) => {
    await tx.campaign.update({ where: { id: campaignId }, data: { fbCampaignId: result.fbCampaignId } });
    for (const s of result.adSets) {
      await tx.adSet.update({ where: { id: s.id }, data: { fbAdSetId: s.fbAdSetId } });
      for (const a of s.ads) await tx.ad.update({ where: { id: a.id }, data: { fbAdId: a.fbAdId } });
    }
  });
}

/**
 * Test-launch (stopgap, task #14): push a complete campaign to Facebook in PAUSED
 * state with the per-ad redirect URL as the destination, to validate the write-path.
 */
export async function testLaunchCampaign(auth: AuthContext, campaignId: string): Promise<TestLaunchResult> {
  const plan = await resolveLaunchPlan(auth, campaignId);
  const result = await createFbStructure(plan, 'PAUSED');
  await persistFbIds(auth, campaignId, result);
  return result;
}

export interface LaunchDeps {
  generateArticle: (auth: AuthContext, campaignId: string) => Promise<{ slug: string }>;
  writeRedirectConfigs: (entries: { redirectId: string; config: RedirectConfigPayload }[]) => Promise<void>;
}
const defaultLaunchDeps: LaunchDeps = {
  generateArticle: (auth, id) => generateArticleForCampaign(auth, id),
  writeRedirectConfigs,
};

export interface LaunchResult {
  status: 'ACTIVE' | 'BATCHED';
  fbCampaignId?: string;
}

/**
 * Rebuild + write each ad's redirect config to edge KV from the campaign's CURRENT
 * offers / channel / article variants — **without touching Facebook**. The FB creative
 * carries only the stable `/go/{redirectId}` link, so rewriting KV reroutes live traffic
 * on the next click with zero ad republish. This is the engine behind post-launch offer
 * rebalancing (weights, article A/B, add/remove). System-scoped (the caller authorizes;
 * also called by the worker after it assigns/releases channels). Mirrors the split-build
 * in `launchCampaign` (kept in sync deliberately — launch stays inline to avoid coupling
 * the critical, stress-tested launch path to this helper).
 */
export async function syncCampaignRedirectConfigs(
  campaignId: string,
  deps: Pick<LaunchDeps, 'writeRedirectConfigs'> = { writeRedirectConfigs },
): Promise<{ ads: number }> {
  const campaign = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, include: campaignInclude }));
  if (!campaign) throw new AppError(404, 'Campaign not found');

  // Campaign default article slug.
  let slug: string | null = null;
  if (campaign.articleId) {
    const a = await withSystem((tx) => tx.article.findUnique({ where: { id: campaign.articleId! }, select: { slug: true } }));
    slug = a?.slug ?? null;
  }
  if (!slug) throw new AppError(409, 'Campaign has no article yet — nothing to route');

  const offers = await withSystem((tx) =>
    tx.offer.findMany({ where: { campaignId }, include: { domain: { select: { host: true } } } }),
  );
  const paidOffers = offers.filter((o) => o.kind === 'PAID' && o.channelRef);

  let articleUrl = `${env.ARTICLE_DOMAIN}/a/${slug}`;
  let channel: string | undefined;
  let splits: RedirectConfigPayload['splits'];
  let organicFallbackUrl: string | undefined;

  if (paidOffers.length > 0) {
    const chRows = await withSystem((tx) =>
      tx.channel.findMany({ where: { id: { in: paidOffers.map((o) => o.channelRef!) } }, select: { id: true, channelId: true } }),
    );
    const chById = new Map(chRows.map((c) => [c.id, c.channelId]));
    const variantIds = [...new Set(offers.map((o) => o.articleId).filter((x): x is string => Boolean(x)))];
    const variantRows = variantIds.length
      ? await withSystem((tx) => tx.article.findMany({ where: { id: { in: variantIds } }, select: { id: true, slug: true } }))
      : [];
    const slugByArticle = new Map(variantRows.map((a) => [a.id, a.slug]));
    const slugFor = (articleId: string | null): string => (articleId ? slugByArticle.get(articleId) ?? slug! : slug!);
    splits = paidOffers.map((o) => ({
      url: `https://${o.domain.host}/a/${slugFor(o.articleId)}`,
      weight: o.weightPct,
      channel: chById.get(o.channelRef!),
      offerId: o.id,
    }));
    const organic = offers.find((o) => o.kind === 'ORGANIC');
    organicFallbackUrl = organic ? `https://${organic.domain.host}/a/${slugFor(organic.articleId)}` : undefined;
    articleUrl = splits[0]?.url ?? articleUrl;
  } else if (campaign.channelId) {
    const ch = await withSystem((tx) => tx.channel.findUnique({ where: { id: campaign.channelId! }, select: { channelId: true } }));
    channel = ch?.channelId;
  }

  const entries = campaign.adSets.flatMap((set) =>
    set.ads
      .filter((ad) => ad.redirectId)
      .map((ad) => ({
        redirectId: ad.redirectId,
        config: {
          campaignId: campaign.id,
          active: campaign.status === CAMPAIGN_STATUS.ACTIVE,
          articleUrl,
          channel,
          splits,
          // referrerAdCreative (the AFS `rc`) is the campaign-level Referrer Ad Creative — one
          // value for all the campaign's ads (not derived from each ad's copy). Stored in racValue.
          adCreative: campaign.racValue ?? undefined,
          fallbackUrl: organicFallbackUrl ?? ad.fallbackUrl ?? campaign.fallbackUrl ?? undefined,
        } satisfies RedirectConfigPayload,
      })),
  );
  try {
    await deps.writeRedirectConfigs(entries);
  } catch (err) {
    // Tolerate an unconfigured edge (mirrors launchCampaign) — never throw on the rebalance path.
    if (err instanceof KvNotConfiguredError) {
      console.warn(`[resync] Cloudflare KV not configured — redirect configs not synced for ${campaignId}`);
    } else {
      throw err;
    }
  }
  return { ads: entries.length };
}

/**
 * The real launch pipeline (Phase 8). For an approved campaign that already has a
 * channel (Phase 6): ensure its article (Phase 5) → write each ad's redirect config
 * to edge KV (Phase 7) → create the Campaign→AdSet→Ad on Facebook **ACTIVE** through
 * the rate-limited client (D12) → ACTIVE + notify. An FB rate-limit parks it in
 * BATCHED for a later retry. Idempotent-ish: a campaign already launched (fbCampaignId)
 * is returned as ACTIVE.
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
      url: `https://${o.domain.host}/a/${slugFor(o.articleId)}`,
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
  }

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
        // referrerAdCreative (AFS `rc`) = the campaign-level Referrer Ad Creative (racValue).
        adCreative: campaign.racValue ?? undefined,
        fallbackUrl: organicFallbackUrl ?? ad.fallbackUrl ?? campaign.fallbackUrl ?? undefined,
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
    const result = await createFbStructure(plan, 'ACTIVE');
    await persistFbIds(auth, campaignId, result);
    await runScoped(auth, async (tx) => {
      await tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.ACTIVE } });
      await writeAudit(tx, {
        orgId: campaign.orgId,
        actorId: auth.userId,
        action: 'campaign.launched',
        entityType: 'campaign',
        entityId: campaignId,
        details: { fbCampaignId: result.fbCampaignId },
      });
    });
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

/**
 * Force a relaunch of an already-launched campaign: pause the existing FB campaign (so its
 * stale ads stop delivering), clear the stored FB ids + reset to PROCESSING, then re-run
 * launchCampaign to re-create Campaign→AdSet→Ad on Facebook with the CURRENT config —
 * notably a corrected `REDIRECT_DOMAIN`/creative link. Used when a live campaign's creatives
 * carry a stale/broken redirect domain. The old FB campaign is left PAUSED (no spend), and a
 * fresh FB campaign is created.
 */
export async function relaunchCampaign(auth: AuthContext, campaignId: string): Promise<LaunchResult> {
  // Resolve the current FB campaign + a token to pause the old delivery (best-effort).
  const info = await runScoped(auth, async (tx) => {
    const c = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, buyerId: true, fbCampaignId: true, adAccountId: true },
    });
    if (!c) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && c.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
    let pause: { fbCampaignId: string; fbAccountId: string; token: string } | null = null;
    if (c.fbCampaignId && c.adAccountId) {
      const acc = await tx.fbAdAccount.findUnique({
        where: { id: c.adAccountId },
        select: { fbAccountId: true, connection: { select: { accessTokenEnc: true } } },
      });
      if (acc) {
        pause = { fbCampaignId: c.fbCampaignId, fbAccountId: acc.fbAccountId, token: decryptConnectionToken(acc.connection.accessTokenEnc) };
      }
    }
    return { pause };
  });

  // Stop the old (stale-link) campaign on Facebook. Best-effort — never block the relaunch.
  if (info.pause) {
    try {
      await updateFbCampaignStatus(info.pause.fbCampaignId, info.pause.fbAccountId, info.pause.token, 'PAUSED');
    } catch (err) {
      console.warn(`[relaunch] could not pause old FB campaign for ${campaignId}: ${(err as Error).message}`);
    }
  }

  // Clear the stored FB ids + reset to PROCESSING so launchCampaign re-creates the structure.
  await runScoped(auth, async (tx) => {
    await tx.ad.updateMany({ where: { adSet: { campaignId } }, data: { fbAdId: null } });
    await tx.adSet.updateMany({ where: { campaignId }, data: { fbAdSetId: null } });
    await tx.campaign.update({ where: { id: campaignId }, data: { fbCampaignId: null, status: CAMPAIGN_STATUS.PROCESSING } });
  });

  return launchCampaign(auth, campaignId);
}
