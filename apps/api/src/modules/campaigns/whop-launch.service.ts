import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '@knn/config';
import { type TxClient, withSystem } from '@knn/db';
import { CAMPAIGN_STATUS, type WhopLaunchAd, type WhopLaunchAdSet, type WhopLaunchCampaign, ROLES, campaignSubmitIssues, isLaunched } from '@knn/shared';
import { type WhopAdCampaign, type WhopApiError, isWhopError, whopAdBody, whopAdGroupBody, whopCampaignBody, whopKeys } from '@knn/whop';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { writeRedirectConfigs } from '../../lib/kv-sync.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { type WhopConnectionRow, type WhopSession, requireWhopConnection, whopFailure, whopSession } from '../whop/whop.internal.js';
import { type CampaignWithChildren, campaignInclude, toDraft } from './campaigns.service.js';
import { clearWhopIds, discardWhopCampaign, whopLeftover } from './whop-cleanup.js';
import { pickWhiteDomain, resolveBuyerFunnelMode, resolveRedirectBase, syncCampaignRedirectConfigs } from './launch-routing.js';

/**
 * Launching a campaign on Whop (D32, phase 2). The Facebook launch (`launch.service.ts`) builds one Meta
 * campaign → ad set → ad tree in a single pass and relies on a rate-limit park for retries. Whop differs in the ways
 * that matter here:
 *
 *  - It is DRAFT-FIRST. A campaign created through the API is a draft; nothing spends until the last step, a PATCH to
 *    `active`, which Whop refuses in words when something is missing (creative, Facebook page, payment method, the
 *    ads agreement). So a half-finished launch costs nothing and can simply be resumed.
 *  - Whop checks the destination of every ad AT CREATION: it loads the URL, follows our redirect and looks for its
 *    pixel on the page it lands on. The edge config must therefore be written (and visible at the edge) first, and
 *    the go-link must land on a page that carries the pixel for a visitor who is not a real ad click.
 *  - Its create calls accept an Idempotency-Key (kept 24 h), and we persist each Whop id the moment it exists, so a
 *    crash or a retry picks up where it stopped and never creates a second campaign, ad group or ad.
 *
 * Order: article → CLAIM (LAUNCHING) → routing + edge config → pixel preflight → campaign → ad groups →
 * (creative upload, ad) per ad → activate → ACTIVE. A failure BEFORE the activation gives the claim back so the campaign
 * can be launched again (what was already created is reused).
 *
 * THE ONE EXPENSIVE MISTAKE is reporting "not launched" while Whop is running the campaign: it spends, and with our edge
 * config inactive every paid click lands on the white page. So the activation is never taken at its word: a failed PATCH
 * is checked against what Whop now says; if Whop cannot be read the claim is NOT given back (the campaign stays
 * LAUNCHING with its edge config active, and the status sync settles it from Whop); and once Whop is live nothing may
 * revert the claim (the save is retried, see `saveLaunched`).
 */

export interface WhopLaunchDeps {
  generateArticle: (auth: AuthContext, campaignId: string) => Promise<{ slug: string }>;
  writeRedirectConfigs: typeof writeRedirectConfigs;
  /** Test seam: the pixel preflight, the creative upload and the save-retry wait between tries. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: how a finished launch is saved (a test makes it fail to prove the claim is then NOT given back). */
  saveLaunched?: typeof saveLaunched;
}

export interface WhopLaunchResult {
  status: 'ACTIVE' | 'BATCHED';
  whopCampaignId?: string;
}

const LAUNCHABLE: readonly string[] = [CAMPAIGN_STATUS.PROCESSING, CAMPAIGN_STATUS.BATCHED];
/** A relaunch may start from any state in which a Whop tree can exist and nobody is mid-launch. */
const RELAUNCHABLE: readonly string[] = [CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED, CAMPAIGN_STATUS.META_REJECTED, CAMPAIGN_STATUS.PROCESSING, CAMPAIGN_STATUS.BATCHED];

/** Whop looks for its pixel on the page a go-link ends on; the config needs a moment to reach every edge location. */
const PIXEL_PREFLIGHT_DELAYS_MS = [0, 4_000, 8_000, 12_000, 16_000, 20_000, 25_000];

type StoredAdSet = CampaignWithChildren['adSets'][number];
type StoredAd = StoredAdSet['ads'][number];

const campaignShape = (c: CampaignWithChildren): WhopLaunchCampaign => ({
  name: c.name,
  objective: c.objective,
  specialAdCategories: c.specialAdCategories,
  budgetMode: c.budgetMode,
  dailyBudgetCents: c.dailyBudgetCents,
});

const adSetShape = (s: StoredAdSet): WhopLaunchAdSet => ({
  name: s.name,
  dailyBudgetCents: s.dailyBudgetCents,
  countries: s.countries,
  excludeCountries: s.excludeCountries,
  ageMin: s.ageMin,
  ageMax: s.ageMax,
  genders: s.genders,
  advantageAudience: s.advantageAudience,
  placementMode: s.placementMode,
  placements: s.placements,
  languages: s.languages,
  devicePlatforms: s.devicePlatforms,
  mobileOs: s.mobileOs,
  bidStrategy: s.bidStrategy,
  costCapCents: s.costCapCents,
  startTime: s.startTime,
  endTime: s.endTime,
  pxeEvent: s.pxeEvent,
});

const adShape = (a: StoredAd): WhopLaunchAd => ({ name: a.name, headline: a.headline, primaryText: a.primaryText, description: a.description, cta: a.cta });

/** The redirect base URL for a host we already chose (env may carry a scheme that is not https, e.g. in dev). */
function baseForHost(host: string): string {
  try {
    if (new URL(env.REDIRECT_DOMAIN).host === host) return env.REDIRECT_DOMAIN.replace(/\/+$/, '');
  } catch {
    /* env may be a bare host */
  }
  return `https://${host}`;
}

const delayOf = (deps: Pick<WhopLaunchDeps, 'sleep'>): ((ms: number) => Promise<void>) => deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

async function loadCampaign(auth: AuthContext, campaignId: string): Promise<CampaignWithChildren> {
  return runScoped(auth, async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId }, include: campaignInclude });
    if (!c) throw new AppError(404, 'Campaign not found');
    if (auth.role === ROLES.MEDIA_BUYER && c.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
    return c;
  });
}

/**
 * Ask Whop (the same check it runs when an ad is created) whether our go-link ends on a page with its pixel. A
 * definitive "no" is retried for ~85 s, because a config written to edge KV a moment ago may not have reached the
 * location Whop's checker hits. If Whop's checker itself is unavailable the preflight steps aside: creating the ad
 * runs the very same check and answers with Whop's own words.
 */
async function preflightPixel(s: WhopSession, url: string, sleep: (ms: number) => Promise<void>): Promise<'installed' | 'skipped' | { reachable: boolean | null }> {
  let last: { reachable: boolean | null } = { reachable: null };
  for (const delay of PIXEL_PREFLIGHT_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      const v = await s.api.validatePixel({ accountId: s.conn.bizId, url });
      if (v.installed) return 'installed';
      last = { reachable: v.reachable ?? null };
    } catch (err) {
      if (isWhopError(err) && ['auth', 'permission', 'payment_required'].includes(err.kind)) throw err;
      console.warn(`[whop-launch] pixel preflight skipped (${err instanceof Error ? err.message : String(err)})`);
      return 'skipped';
    }
  }
  return last;
}

/** What to tell the buyer for a launch that Whop or we stopped. The bare reason, no prefix. */
function launchFailureMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (isWhopError(err)) return err.message;
  return err instanceof Error ? err.message : 'an unexpected error';
}

async function recordLaunchError(auth: AuthContext, campaignId: string, message: string): Promise<void> {
  await runScoped(auth, (tx) =>
    tx.campaign.update({
      where: { id: campaignId },
      data: { whopIssues: [{ id: 'knn-launch', message, resource_id: null, resource_type: 'ad_campaign' }] },
    }),
  ).catch(() => undefined);
}

/**
 * Whop was asked to activate the campaign and we cannot tell what it did: the PATCH failed AND Whop could not be read
 * afterwards. The campaign may be running. See `failLaunch`.
 */
class ActivationUnknownError extends Error {
  constructor(readonly whopError: WhopApiError) {
    super('Whop did not confirm whether the campaign went live.');
    this.name = 'ActivationUnknownError';
  }
}

/** Try again a couple of times (a transient database hiccup), then give up. */
async function withRetries<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, delays: readonly number[] = [500, 1500]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= delays.length) throw err;
      await sleep(delays[i]!);
    }
  }
}

/**
 * The Whop counterpart of `launchCampaign`. Routed to from there when `campaign.adProvider === 'WHOP'`, for
 * the manual Launch button and the worker's auto-launch alike (both arrive through `launchCampaign`).
 */
export async function launchWhopCampaign(auth: AuthContext, campaign: CampaignWithChildren, deps: WhopLaunchDeps): Promise<WhopLaunchResult> {
  const campaignId = campaign.id;
  if (isLaunched(campaign)) return { status: 'ACTIVE', whopCampaignId: campaign.whopCampaignId ?? undefined };

  // Preconditions first, while nothing has been touched.
  if (campaign.status === CAMPAIGN_STATUS.LAUNCHING) throw new AppError(409, 'This campaign is already being launched. Give it a moment.');
  if (!LAUNCHABLE.includes(campaign.status)) {
    throw new AppError(409, `This campaign is ${campaign.status.toLowerCase().replace(/_/g, ' ')}. It can be launched once it is approved and has its channel.`);
  }
  const conn = await requireWhopConnection(campaign, 'launch this campaign');
  const issues = campaignSubmitIssues(toDraft(campaign));
  if (issues.length > 0) throw new AppError(422, 'Campaign is not complete enough to launch', issues);
  if (!campaign.whopPageId) throw new AppError(400, 'Campaign is missing its Facebook page');
  const page = await withSystem((tx) => tx.whopSocialAccount.findFirst({ where: { connectionId: conn.id, whopId: campaign.whopPageId!, platform: 'facebook' }, select: { id: true } }));
  if (!page) throw new AppError(409, 'The page chosen for this campaign is no longer a Facebook page on the Whop business. Pick another page, then launch.');

  // Channels, exactly as the Facebook launch requires them.
  const offers = await runScoped(auth, (tx) => tx.offer.findMany({ where: { campaignId }, select: { kind: true, channelRef: true } }));
  const paidOffers = offers.filter((o) => o.kind === 'PAID');
  if (paidOffers.length > 0) {
    if (paidOffers.some((o) => !o.channelRef)) throw new AppError(409, 'Offers have no channels assigned yet');
  } else if (!campaign.channelId) {
    throw new AppError(409, 'Campaign has no channel assigned yet');
  }

  // 1. The article (it is what the edge routes paid clicks to).
  if (campaign.articleId) {
    const article = await runScoped(auth, (tx) => tx.article.findUnique({ where: { id: campaign.articleId! }, select: { id: true } }));
    if (!article) throw new AppError(409, 'Campaign article is missing');
  } else {
    await deps.generateArticle(auth, campaignId);
  }

  // 2. Claim. SINGLE-WRITER GUARD, same reasoning as the Facebook launch: auto-launch and a manual click can race, and
  //    only the caller whose conditional UPDATE matches may change anything from here on, including which redirect host
  //    the campaign rotates onto and what the edge config says (so the loser can never overwrite the winner's routing).
  const claim = await runScoped(auth, (tx) =>
    tx.campaign.updateMany({ where: { id: campaignId, adProvider: 'WHOP', status: { in: [CAMPAIGN_STATUS.PROCESSING, CAMPAIGN_STATUS.BATCHED] } }, data: { status: CAMPAIGN_STATUS.LAUNCHING } }),
  );
  if (claim.count === 0) {
    const cur = await runScoped(auth, (tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true, adProvider: true, whopCampaignId: true, fbCampaignId: true } }));
    if (cur && isLaunched(cur)) return { status: 'ACTIVE', whopCampaignId: cur.whopCampaignId ?? undefined };
    throw new AppError(409, 'This campaign is already being launched. Give it a moment.');
  }

  let redirect: { base: string; host: string };
  let result: BuildResult;
  try {
    // 3. Routing, then the edge config written ACTIVE before Whop looks at the go-link (see `forceActive`). A real KV failure
    //    stops the launch here, like Facebook's; an unconfigured edge is tolerated. Read the campaign again now that the claim
    //    is ours: the snapshot above is from before it.
    redirect = await prepareRouting(auth, await loadCampaign(auth, campaignId), deps);
    result = await buildAndActivate(auth, campaignId, conn, redirect, deps);
  } catch (err) {
    return failLaunch(auth, campaign, conn, deps, err);
  }

  // Whop is live from here on. NOTHING below may give the claim back: that would show "not launched" and, once the edge
  // config is rewritten from the status, send paid clicks to the white page while Whop spends. Saving the result is
  // retried; if it still cannot be saved the campaign stays LAUNCHING with its edge config active, and the status sync
  // completes it from what Whop reports (`recoverStuckLaunches` in the worker).
  try {
    await withRetries(() => (deps.saveLaunched ?? saveLaunched)(auth, campaign, result, redirect.host), delayOf(deps));
  } catch (err) {
    console.error(`[whop-launch] ${campaignId} is live on Whop (${result.whopCampaignId}) but saving that failed: ${err instanceof Error ? err.message : String(err)}`);
    await notify({
      orgId: campaign.orgId,
      userId: campaign.buyerId,
      type: 'whop_launch_unrecorded',
      title: 'A Whop campaign is live, but we could not record it',
      body: `"${campaign.name}" launched on Whop (${result.whopCampaignId}) and our database did not accept the update. It is completed automatically within about half an hour; do not launch it again.`,
    });
    throw new AppError(502, 'The campaign is live on Whop, but saving that failed just now. It is completed automatically within about half an hour: do not launch it again.');
  }
  // Now that the status is ACTIVE the config derives `active` itself; best-effort, like the Facebook launch.
  await syncCampaignRedirectConfigs(campaignId, { writeRedirectConfigs: deps.writeRedirectConfigs }).catch((e) =>
    console.warn(`[whop-launch] post-launch redirect resync failed for ${campaignId}: ${e instanceof Error ? e.message : String(e)}`),
  );
  await notify({
    orgId: campaign.orgId,
    userId: campaign.buyerId,
    type: 'campaign.live',
    title: 'Campaign is live',
    body: `"${campaign.name}" is now live on Whop. Meta reviews new ads first, so delivery can take a while to start.`,
  });
  return { status: 'ACTIVE', whopCampaignId: result.whopCampaignId };
}

/** Record a finished launch: the status Whop reports (ACTIVE, or PAUSED if it was paused meanwhile), the host, the audit entry. */
export async function saveLaunched(auth: AuthContext, campaign: CampaignWithChildren, result: BuildResult, redirectHost: string): Promise<void> {
  await runScoped(auth, async (tx) => {
    await tx.campaign.update({
      where: { id: campaign.id },
      data: {
        status: result.paused ? CAMPAIGN_STATUS.PAUSED : CAMPAIGN_STATUS.ACTIVE,
        redirectDomainHost: redirectHost,
        whopDeliveryStatus: result.deliveryStatus,
        whopIssues: result.issues,
      },
    });
    await writeAudit(tx, {
      orgId: campaign.orgId,
      actorId: auth.userId,
      action: 'campaign.launched',
      entityType: 'campaign',
      entityId: campaign.id,
      details: { provider: 'WHOP', whopCampaignId: result.whopCampaignId },
    });
  });
}

/**
 * Choose and save the campaign's routing, then write its edge config. Once a Whop campaign exists an ad's URL (and so the
 * redirect host in it) may already be fixed at Whop, so the host is reused from then on; before that a retry may rotate onto a
 * healthier one. The white host (cloaker funnels) is stable once chosen. The config is written ACTIVE so the go-link looks, to
 * Whop's checker, the way it will when real clicks arrive.
 */
async function prepareRouting(auth: AuthContext, campaign: CampaignWithChildren, deps: WhopLaunchDeps): Promise<{ base: string; host: string }> {
  const funnelMode = await resolveBuyerFunnelMode(campaign.orgId, campaign.buyerId);
  const redirect =
    campaign.whopCampaignId && campaign.redirectDomainHost
      ? { base: baseForHost(campaign.redirectDomainHost), host: campaign.redirectDomainHost }
      : await resolveRedirectBase(funnelMode, campaign.orgId);
  const whiteHost = funnelMode === 'CLOAKER' ? campaign.whiteDomainHost ?? (await pickWhiteDomain()) : undefined;
  await runScoped(auth, (tx) => tx.campaign.update({ where: { id: campaign.id }, data: { redirectDomainHost: redirect.host, whiteDomainHost: whiteHost ?? null } }));
  await syncCampaignRedirectConfigs(campaign.id, { writeRedirectConfigs: deps.writeRedirectConfigs }, { forceActive: true });
  return redirect;
}

export interface BuildResult {
  whopCampaignId: string;
  paused: boolean;
  deliveryStatus: string;
  issues: { id: string; message: string; resource_id: string | null; resource_type: string }[];
}

/** What a Whop campaign that is past draft reports, as the result of a launch. */
const resultOf = (whopCampaignId: string, live: WhopAdCampaign): BuildResult => ({
  whopCampaignId,
  paused: live.status === 'paused',
  deliveryStatus: live.delivery_status,
  issues: live.issues ?? [],
});

/** Bump the campaign row's `updated_at`: the stuck-launch recovery reads it as "this launch is alive". */
const touch = (tx: TxClient, campaignId: string): Promise<unknown> => tx.campaign.update({ where: { id: campaignId }, data: { updatedAt: new Date() } });

/** Create (or resume) the Whop tree for a claimed campaign and activate it. */
async function buildAndActivate(
  auth: AuthContext,
  campaignId: string,
  conn: WhopConnectionRow,
  redirect: { base: string; host: string },
  deps: WhopLaunchDeps,
): Promise<BuildResult> {
  const sleep = delayOf(deps);
  const s = whopSession(conn, { sleep });
  const log = (m: string): void => console.log(`[whop-launch] ${campaignId}: ${m}`);

  let c = await loadCampaign(auth, campaignId);
  if (!c.adSets.flatMap((x) => x.ads)[0]) throw new AppError(422, 'Campaign is not complete enough to launch', ['Add at least one ad']);

  /**
   * Whop no longer has part of the tree we recorded (someone deleted it in Whop): forget every id (which moves the campaign
   * to its next key epoch, so Whop does not replay the deleted objects from its 24 h idempotency cache), delete what is left
   * of the old Whop campaign, and build fresh. A whole-tree rebuild is the one repair that is always correct.
   */
  const heal = async (why: string): Promise<void> => {
    log(`${why}; rebuilding`);
    const left = whopLeftover(c);
    await runScoped(auth, (tx) => clearWhopIds(tx, campaignId));
    c = await loadCampaign(auth, campaignId);
    if (left) await discardWhopCampaign(left, auth.userId);
  };

  // 0. What does Whop hold? A campaign already past draft means an earlier run's activation landed (its answer, or our save
  //    of it, was lost): there is nothing to check or create, only to finish. It is decided BEFORE the pixel preflight, which
  //    could otherwise fail first and keep a live campaign from being recognised.
  if (c.whopCampaignId) {
    let held: WhopAdCampaign | null = null;
    try {
      held = await s.ads.getCampaign(c.whopCampaignId);
    } catch (err) {
      if (!(isWhopError(err) && err.kind === 'not_found')) throw err;
      await heal(`Whop no longer has ${c.whopCampaignId}`);
    }
    if (held && held.status !== 'draft') return resultOf(c.whopCampaignId, held);
  }

  // A. Preflight: does Whop see its pixel at the end of our go-link?
  const firstAd = c.adSets.flatMap((x) => x.ads)[0]!;
  const pixel = await preflightPixel(s, `${redirect.base}/go/${firstAd.redirectId}`, sleep);
  if (typeof pixel === 'object') {
    throw new AppError(
      409,
      pixel.reachable === false
        ? `Whop could not load ${redirect.base}/go/${firstAd.redirectId}. Check that the redirect domain is live, then launch again.`
        : `Whop's pixel was not found on the page ${redirect.base}/go/${firstAd.redirectId} lands on. The landing page for visitors who are not ad clicks must carry the Whop pixel: check the white site / article deployment and WHOP_SCOPE_SECRET, then launch again.`,
    );
  }

  // B-D. The tree: campaign, ad groups, then creative + ad per ad, each id saved the moment it exists.
  const ensureTree = async (): Promise<string> => {
    const epoch = c.whopKeyEpoch;
    let whopCampaignId = c.whopCampaignId;
    if (!whopCampaignId) {
      const created = await s.ads.createCampaign(whopCampaignBody(campaignShape(c), conn.bizId, whopKeys.campaign(campaignId, epoch)));
      whopCampaignId = created.id;
      await runScoped(auth, async (tx) => {
        await tx.campaign.update({ where: { id: campaignId }, data: { whopCampaignId: created.id, whopBizId: conn.bizId, whopDeliveryStatus: created.delivery_status } });
      });
      log(`created Whop campaign ${created.id}`);
    }
    for (const set of c.adSets) {
      if (set.whopAdGroupId) continue;
      const group = await s.ads.createAdGroup(whopAdGroupBody(adSetShape(set), whopCampaignId, c.budgetMode, whopKeys.adGroup(set.id, epoch)));
      await runScoped(auth, async (tx) => {
        await tx.adSet.update({ where: { id: set.id }, data: { whopAdGroupId: group.id } });
        await touch(tx, campaignId);
      });
      set.whopAdGroupId = group.id;
      log(`created ad group ${group.id} for "${set.name}"`);
    }
    for (const set of c.adSets) {
      for (const ad of set.ads) {
        if (ad.whopAdId) continue;
        const fileId = ad.whopFileId ?? (await uploadCreative(auth, s, ad, epoch, campaignId));
        const created = await s.ads.createAd(
          whopAdBody(adShape(ad), { adGroupId: set.whopAdGroupId!, url: `${redirect.base}/go/${ad.redirectId}`, fileId, pageId: c.whopPageId }, whopKeys.ad(ad.id, epoch)),
        );
        await runScoped(auth, async (tx) => {
          await tx.ad.update({ where: { id: ad.id }, data: { whopAdId: created.id } });
          await touch(tx, campaignId);
        });
        ad.whopAdId = created.id;
        log(`created ad ${created.id} for "${ad.name}"`);
      }
    }
    return whopCampaignId;
  };
  let whopCampaignId: string;
  try {
    whopCampaignId = await ensureTree();
  } catch (err) {
    // A 404 here means part of what we recorded (an ad group, an ad) is gone at Whop: rebuild the whole tree, once.
    if (!(isWhopError(err) && err.kind === 'not_found')) throw err;
    await heal('part of the Whop tree was deleted in Whop');
    whopCampaignId = await ensureTree();
  }

  // E. Activate. A campaign that is already past draft (an earlier run's PATCH landed but its answer was lost) is not
  //    launched again. The same goes for THIS call failing: the client retries a PATCH after a lost answer, and that second
  //    call meets a campaign that is already live, so a refusal is checked against what Whop now says before it is believed.
  //    Only a campaign still in draft was really refused; one Whop cannot be read about is UNKNOWN, which is not a refusal.
  let live = await s.ads.getCampaign(whopCampaignId);
  if (live.status === 'draft') {
    try {
      live = await s.ads.launchCampaign(whopCampaignId);
    } catch (err) {
      if (!isWhopError(err)) throw err;
      const after = await s.ads.getCampaign(whopCampaignId).catch(() => null);
      if (after === null) throw new ActivationUnknownError(err);
      if (after.status === 'draft') throw err;
      live = after;
    }
    log(`activated; Whop says ${live.status}/${live.delivery_status}`);
  }
  return resultOf(whopCampaignId, live);
}

/** Upload one ad's creative to Whop and remember the file. */
async function uploadCreative(auth: AuthContext, s: WhopSession, ad: StoredAd, epoch: number, campaignId: string): Promise<string> {
  const upload = ad.uploadId
    ? await runScoped(auth, (tx) => tx.upload.findUnique({ where: { id: ad.uploadId! }, select: { storageKey: true, kind: true, filename: true } }))
    : null;
  if (!upload?.storageKey) throw new AppError(400, `Ad "${ad.name}" has no creative file`);
  const noun = upload.kind === 'VIDEO' ? 'video' : 'image';
  let bytes: Buffer;
  try {
    bytes = await readFile(join(env.UPLOAD_DIR, upload.storageKey));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new AppError(409, `Ad "${ad.name}": its creative ${noun} is missing on the server. Reopen the campaign, re-upload the ${noun}, then launch again.`);
    }
    throw err;
  }
  const file = await s.ads.uploadCreative({
    filename: upload.filename ?? `${ad.name}.${upload.kind === 'VIDEO' ? 'mp4' : 'png'}`,
    bytes,
    idempotencyKey: whopKeys.file(ad.id, epoch),
    // A video takes Whop longer to process than an image.
    timeoutMs: upload.kind === 'VIDEO' ? 180_000 : 60_000,
  });
  await runScoped(auth, async (tx) => {
    await tx.ad.update({ where: { id: ad.id }, data: { whopFileId: file.id } });
    await touch(tx, campaignId);
  });
  return file.id;
}

/**
 * A launch that did not finish BEFORE Whop was live: give the claim back so it can be launched again, put the edge config
 * back to what the status says, tell the buyer why, and answer the caller. What Whop already holds stays and is reused
 * next time. The one exception is an activation whose outcome we cannot read (`ActivationUnknownError`): the campaign may be
 * running, so the claim stays and the edge config stays active until the status sync can ask Whop.
 */
async function failLaunch(auth: AuthContext, campaign: CampaignWithChildren, conn: WhopConnectionRow, deps: WhopLaunchDeps, err: unknown): Promise<WhopLaunchResult> {
  const campaignId = campaign.id;

  if (err instanceof ActivationUnknownError) {
    console.error(`[whop-launch] activation of ${campaignId} is unconfirmed (kind=${err.whopError.kind} status=${err.whopError.status}): leaving it LAUNCHING for the status sync`);
    await notify({
      orgId: campaign.orgId,
      userId: campaign.buyerId,
      type: 'whop_launch_unconfirmed',
      title: 'A Whop campaign may be live',
      body: `"${campaign.name}": Whop did not confirm whether the launch went through. It is checked automatically within about half an hour; do not launch it again.`,
    });
    throw new AppError(502, 'Whop did not confirm whether the campaign went live. It is checked automatically within about half an hour: do not launch it again.');
  }

  const whopErr: WhopApiError | null = isWhopError(err) ? err : null;
  if (whopErr) console.error(`[whop-launch] Whop error on campaign ${campaignId}: kind=${whopErr.kind} status=${whopErr.status} :: ${whopErr.message}`);

  // Whop is pacing us: park it, like a Facebook rate limit. What exists is kept.
  if (whopErr?.kind === 'rate_limited') {
    await runScoped(auth, (tx) => tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.BATCHED } })).catch(() => undefined);
    // Nothing is live yet: put the edge config back to what BATCHED means (inactive), and say why it is parked.
    await syncCampaignRedirectConfigs(campaignId, { writeRedirectConfigs: deps.writeRedirectConfigs }).catch(() => undefined);
    await recordLaunchError(auth, campaignId, 'Whop asked us to slow down, so this launch is parked. Launch it again in a minute: everything Whop already holds is reused.');
    const cur = await runScoped(auth, (tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { whopCampaignId: true } })).catch(() => null);
    return { status: 'BATCHED', whopCampaignId: cur?.whopCampaignId ?? undefined };
  }

  await runScoped(auth, (tx) => tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.PROCESSING } })).catch(() => undefined);
  // The config was written ACTIVE for the pixel check; the status is PROCESSING again, so this derives `active: false`.
  await syncCampaignRedirectConfigs(campaignId, { writeRedirectConfigs: deps.writeRedirectConfigs }).catch(() => undefined);

  const appError = whopErr ? await whopFailure(conn, whopErr) : null;
  // Whop's refusals to launch name what to fix in Whop (payment method, page, agreement): show them as the launch's.
  const mapped =
    appError && whopErr?.kind === 'validation'
      ? new AppError(409, `Whop would not launch this campaign: ${whopErr.message}`, appError.details)
      : appError;
  const message = launchFailureMessage(mapped ?? err);
  await recordLaunchError(auth, campaignId, message);
  await notify({
    orgId: campaign.orgId,
    userId: campaign.buyerId,
    type: 'whop_launch_failed',
    title: 'A Whop campaign could not launch',
    body: `"${campaign.name}": ${message}`,
  });
  throw mapped ?? err;
}

/**
 * Whop's half of `relaunchCampaign`: stop the old Whop campaign delivering (kept, paused, like the old Facebook
 * one), forget the Whop ids (the uploaded creatives are kept: they do not go stale), rotate onto a fresh redirect host,
 * and launch again with the current config.
 *
 * Stricter than Facebook's on purpose, because Whop's old campaign is left behind and we are about to forget its id: if it
 * cannot be shown to be stopped, nothing is cleared and nothing is built beside it (two live campaigns would double the
 * spend, and the old one would never be paused or read again). A mid-launch or finished campaign cannot be relaunched.
 */
export async function relaunchWhopCampaign(auth: AuthContext, campaignId: string, deps: WhopLaunchDeps): Promise<WhopLaunchResult> {
  const campaign = await loadCampaign(auth, campaignId);
  if (!RELAUNCHABLE.includes(campaign.status)) {
    throw new AppError(409, `A campaign that is ${campaign.status.toLowerCase().replace(/_/g, ' ')} cannot be relaunched.`);
  }
  const conn = await requireWhopConnection(campaign, 'relaunch this campaign');
  if (campaign.whopCampaignId) {
    const { ads } = whopSession(conn);
    try {
      await ads.pauseCampaign(campaign.whopCampaignId);
    } catch (err) {
      // Deleted in Whop, or not delivering anyway: nothing to stop. Anything else means the old campaign may still be spending.
      if (!isWhopError(err)) throw err;
      if (err.kind !== 'not_found') {
        const now = await ads.getCampaign(campaign.whopCampaignId).catch(() => null);
        if (!now || !['paused', 'draft'].includes(now.status)) throw await whopFailure(conn, err);
      }
    }
  }
  await runScoped(auth, async (tx) => {
    // Conditional on what we just read: a launch that claimed the campaign meanwhile must not be stepped on.
    const flipped = await tx.campaign.updateMany({
      where: { id: campaign.id, adProvider: 'WHOP', status: campaign.status, whopCampaignId: campaign.whopCampaignId },
      data: { status: CAMPAIGN_STATUS.PROCESSING, redirectDomainHost: null },
    });
    if (flipped.count === 0) throw new AppError(409, 'The campaign changed while it was being relaunched. Check it, then try again.');
    await clearWhopIds(tx, campaign.id, { keepFiles: true });
  });
  return launchWhopCampaign(auth, await loadCampaign(auth, campaign.id), deps);
}
