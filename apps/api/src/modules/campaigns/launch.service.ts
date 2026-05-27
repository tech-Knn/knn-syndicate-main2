import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '@knn/config';
import { FbConnectionStatus } from '@knn/db';
import {
  createFbAd,
  createFbAdCreative,
  createFbAdSet,
  createFbCampaign,
  decryptToken,
  uploadFbAdImage,
} from '@knn/fb';
import { ROLES, campaignSubmitIssues } from '@knn/shared';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { type CampaignWithChildren, campaignInclude, toDraft } from './campaigns.service.js';

/** Our pxe → a Facebook standard conversion event (best-effort for the test path). */
const PXE_TO_EVENT: Record<string, string> = {
  search: 'SEARCH',
  lander: 'VIEW_CONTENT',
  adclick: 'LEAD',
};

export interface TestLaunchResult {
  fbCampaignId: string;
  adSets: { id: string; fbAdSetId: string; ads: { id: string; fbAdId: string }[] }[];
}

type StoredAdSet = CampaignWithChildren['adSets'][number];

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

/**
 * Test-launch (DECISION: stopgap before the real Phase 8 pipeline). Pushes a
 * complete campaign to Facebook in **PAUSED** state with the per-ad redirect URL
 * as the destination, to validate the create write-path. Bid strategy is forced to
 * the default (no cap) and placements are left automatic to keep the test simple.
 */
export async function testLaunchCampaign(auth: AuthContext, campaignId: string): Promise<TestLaunchResult> {
  // 1. Read phase — validate + resolve all FB ids + the owner's token (no network in the txn).
  const plan = await runScoped(auth, async (tx) => {
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

  const { campaign, token, fbAccountId, fbPageId } = plan;
  const cbo = campaign.budgetMode === 'CAMPAIGN';

  // 2. FB write phase — campaign → ad sets → (image, creative, ad). All PAUSED.
  const fbCampaign = await createFbCampaign(fbAccountId, token, {
    name: campaign.name,
    objective: campaign.objective,
    specialAdCategories: campaign.specialAdCategories,
    status: 'PAUSED',
    dailyBudgetCents: cbo ? campaign.dailyBudgetCents ?? undefined : undefined,
  });

  const adSets: TestLaunchResult['adSets'] = [];
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
      status: 'PAUSED',
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
        status: 'PAUSED',
      });
      adResults.push({ id: ad.id, fbAdId: fbAd.id });
    }
    adSets.push({ id: set.id, fbAdSetId: fbAdSet.id, ads: adResults });
  }

  // 3. Persist the returned FB ids.
  await runScoped(auth, async (tx) => {
    await tx.campaign.update({ where: { id: campaign.id }, data: { fbCampaignId: fbCampaign.id } });
    for (const s of adSets) {
      await tx.adSet.update({ where: { id: s.id }, data: { fbAdSetId: s.fbAdSetId } });
      for (const a of s.ads) await tx.ad.update({ where: { id: a.id }, data: { fbAdId: a.fbAdId } });
    }
  });

  return { fbCampaignId: fbCampaign.id, adSets };
}
