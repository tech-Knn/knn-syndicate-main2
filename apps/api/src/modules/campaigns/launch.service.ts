import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '@knn/config';
import { FbConnectionStatus } from '@knn/db';
import {
  FbRateLimitError,
  createFbAd,
  createFbAdCreative,
  createFbAdSet,
  createFbCampaign,
  decryptToken,
  uploadFbAdImage,
} from '@knn/fb';
import { CAMPAIGN_STATUS, ROLES, campaignSubmitIssues, canTransitionCampaign } from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { KvNotConfiguredError, type RedirectConfigPayload, writeRedirectConfigs } from '../../lib/kv-sync.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { generateArticleForCampaign } from '../articles/articles.service.js';
import { type CampaignWithChildren, campaignInclude, toDraft } from './campaigns.service.js';

/** Our pxe → a Facebook standard conversion event. */
const PXE_TO_EVENT: Record<string, string> = {
  search: 'SEARCH',
  lander: 'VIEW_CONTENT',
  adclick: 'LEAD',
};

export interface FbStructureResult {
  fbCampaignId: string;
  adSets: { id: string; fbAdSetId: string; ads: { id: string; fbAdId: string }[] }[];
}
export type TestLaunchResult = FbStructureResult;

type StoredAdSet = CampaignWithChildren['adSets'][number];

interface LaunchPlan {
  campaign: CampaignWithChildren;
  token: string;
  fbAccountId: string;
  fbPageId: string;
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

    const conn = await tx.fbConnection.findUnique({ where: { userId: campaign.buyerId } });
    if (!conn) throw new AppError(400, 'The campaign owner has no Facebook connection');
    if (conn.status === FbConnectionStatus.CONNECTION_BROKEN) {
      throw new AppError(409, 'Facebook connection is broken — reconnect first');
    }

    const [adAccount, page] = await Promise.all([
      tx.fbAdAccount.findUnique({ where: { id: campaign.adAccountId }, select: { fbAccountId: true } }),
      tx.fbPage.findUnique({ where: { id: campaign.pageId }, select: { fbPageId: true } }),
    ]);
    if (!adAccount || !page) throw new AppError(400, 'Selected ad account/page no longer exists');

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

    return { campaign, token: decryptToken(conn.accessTokenEnc), fbAccountId: adAccount.fbAccountId, fbPageId: page.fbPageId, adSets };
  });
}

/** FB write phase — campaign → ad sets → (image, creative, ad), all at `status`. */
async function createFbStructure(plan: LaunchPlan, status: 'PAUSED' | 'ACTIVE'): Promise<FbStructureResult> {
  const { campaign, token, fbAccountId, fbPageId } = plan;
  const cbo = campaign.budgetMode === 'CAMPAIGN';

  const fbCampaign = await createFbCampaign(fbAccountId, token, {
    name: campaign.name,
    objective: campaign.objective,
    specialAdCategories: campaign.specialAdCategories,
    status,
    dailyBudgetCents: cbo ? campaign.dailyBudgetCents ?? undefined : undefined,
  });

  const adSets: FbStructureResult['adSets'] = [];
  for (const { set, fbPixelId, ads } of plan.adSets) {
    const fbAdSet = await createFbAdSet(fbAccountId, token, {
      name: set.name,
      campaignId: fbCampaign.id,
      optimizationGoal: set.optimizationGoal,
      billingEvent: set.billingEvent,
      dailyBudgetCents: cbo ? undefined : set.dailyBudgetCents ?? undefined,
      promotedObject: fbPixelId
        ? { pixel_id: fbPixelId, custom_event_type: PXE_TO_EVENT[set.pxeEvent] ?? 'SEARCH' }
        : undefined,
      targeting: buildTargeting(set),
      startTime: set.startTime?.toISOString(),
      endTime: set.endTime?.toISOString(),
      status,
    });

    const adResults: { id: string; fbAdId: string }[] = [];
    for (const { ad, storageKey } of ads) {
      if (!storageKey) throw new AppError(400, `Ad "${ad.name}" has no creative file`);
      const bytes = await readFile(join(env.UPLOAD_DIR, storageKey));
      const imageHash = await uploadFbAdImage(fbAccountId, token, bytes.toString('base64'));
      const destination = `${env.REDIRECT_DOMAIN}/go/${ad.redirectId}`;
      const creative = await createFbAdCreative(fbAccountId, token, {
        name: ad.name,
        objectStorySpec: {
          page_id: fbPageId,
          link_data: {
            link: destination,
            message: ad.primaryText,
            name: ad.headline,
            ...(ad.description ? { description: ad.description } : {}),
            image_hash: imageHash,
            call_to_action: { type: ad.cta, value: { link: destination } },
          },
        },
      });
      const fbAd = await createFbAd(fbAccountId, token, {
        name: ad.name,
        adSetId: fbAdSet.id,
        creativeId: creative.id,
        status,
      });
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

/** Verbatim ad creative for AFS `referrerAdCreative` (required for paid traffic). */
function buildAdCreativeText(ad: StoredAdSet['ads'][number]): string {
  return [ad.headline, ad.primaryText, ad.description].filter(Boolean).join('. ');
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
    splits = paidOffers.map((o) => ({
      url: `https://${o.domain.host}/a/${slug}`,
      weight: o.weightPct,
      channel: chById.get(o.channelRef!),
      offerId: o.id,
    }));
    // The ORGANIC offer (if configured) is where non-ad traffic goes.
    const organic = offers.find((o) => o.kind === 'ORGANIC');
    organicFallbackUrl = organic ? `https://${organic.domain.host}/a/${slug}` : undefined;
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
        rac: campaign.racValue ?? undefined,
        adCreative: buildAdCreativeText(ad),
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

  // 4. LAUNCHING → create on FB → ACTIVE (or BATCHED on rate limit).
  await runScoped(auth, async (tx) => {
    if (canTransitionCampaign(campaign.status, CAMPAIGN_STATUS.LAUNCHING)) {
      await tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.LAUNCHING } });
    }
  });

  try {
    const plan = await resolveLaunchPlan(auth, campaignId);
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
    if (err instanceof FbRateLimitError) {
      await runScoped(auth, (tx) =>
        tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.BATCHED } }),
      );
      return { status: 'BATCHED' };
    }
    throw err;
  }
}
