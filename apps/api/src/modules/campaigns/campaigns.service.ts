import { type Prisma, type TxClient } from '@knn/db';
import {
  type AttributionWindow,
  type CampaignDraft,
  type ConversionType,
  type CtaOption,
  type DevicePlatform,
  type Gender,
  type MobileOs,
  type PlacementMode,
  type PxeEvent,
  ROLES,
  type SpecialAdCategory,
  campaignSubmitIssues,
} from '@knn/shared';
import { AppError } from '../../lib/errors.js';
import { generateRedirectId } from '../../lib/ids.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';

const campaignInclude = {
  adSets: { orderBy: { createdAt: 'asc' }, include: { ads: { orderBy: { createdAt: 'asc' } } } },
} satisfies Prisma.CampaignInclude;

/** The FB asset ids the acting user is allowed to reference (their own connection's). */
async function ownedAssetIds(
  tx: TxClient,
  userId: string,
): Promise<{ accounts: Set<string>; pages: Set<string>; pixels: Set<string> }> {
  const conn = await tx.fbConnection.findUnique({ where: { userId }, select: { id: true } });
  if (!conn) return { accounts: new Set(), pages: new Set(), pixels: new Set() };
  const [accounts, pages] = await Promise.all([
    tx.fbAdAccount.findMany({ where: { connectionId: conn.id }, select: { id: true } }),
    tx.fbPage.findMany({ where: { connectionId: conn.id }, select: { id: true } }),
  ]);
  const accountIds = accounts.map((a) => a.id);
  const pixels = await tx.fbPixel.findMany({
    where: { adAccountId: { in: accountIds } },
    select: { id: true },
  });
  return {
    accounts: new Set(accountIds),
    pages: new Set(pages.map((p) => p.id)),
    pixels: new Set(pixels.map((p) => p.id)),
  };
}

/** Reject any selected FB asset that isn't one of the acting user's synced assets. */
async function assertAssetsOwned(tx: TxClient, userId: string, input: CampaignDraft): Promise<void> {
  const owned = await ownedAssetIds(tx, userId);
  if (input.adAccountId && !owned.accounts.has(input.adAccountId)) {
    throw new AppError(400, 'Selected ad account is not connected to your account');
  }
  if (input.pageId && !owned.pages.has(input.pageId)) {
    throw new AppError(400, 'Selected page is not connected to your account');
  }
  for (const set of input.adSets) {
    if (set.pixelId && !owned.pixels.has(set.pixelId)) {
      throw new AppError(400, `Pixel for ad set "${set.name}" is not connected to your account`);
    }
  }
}

function adSetCreateInputs(orgId: string, input: CampaignDraft): Prisma.AdSetCreateWithoutCampaignInput[] {
  return input.adSets.map((set) => ({
    orgId,
    name: set.name,
    dailyBudgetCents: set.dailyBudgetCents ?? null,
    billingEvent: set.billingEvent,
    optimizationGoal: set.optimizationGoal,
    bidStrategy: set.bidStrategy ?? null,
    countries: set.countries,
    excludeCountries: set.excludeCountries,
    ageMin: set.ageMin,
    ageMax: set.ageMax,
    genders: set.genders,
    languages: set.languages,
    devicePlatforms: set.devicePlatforms,
    mobileOs: set.mobileOs,
    advantageAudience: set.advantageAudience,
    placementMode: set.placementMode,
    placements: set.placements,
    pixelId: set.pixelId ?? null,
    pxeEvent: set.pxeEvent,
    conversionType: set.conversionType,
    costCapCents: set.costCapCents ?? null,
    roasFactor: set.roasFactor ?? null,
    attributionWindow: set.attributionWindow ?? null,
    startTime: set.startTime ? new Date(set.startTime) : null,
    endTime: set.endTime ? new Date(set.endTime) : null,
    timezone: set.timezone ?? null,
    ads: {
      create: set.ads.map((ad) => ({
        orgId,
        name: ad.name,
        headline: ad.headline,
        primaryText: ad.primaryText,
        description: ad.description,
        cta: ad.cta,
        creativeType: ad.creativeType,
        uploadId: ad.uploadId,
        fallbackUrl: ad.fallbackUrl,
        beneficiary: ad.beneficiary,
        redirectId: generateRedirectId(),
      })),
    },
  }));
}

// Coerce optionals to null so a wholesale draft update can also *clear* a field.
function campaignScalars(_orgId: string, input: CampaignDraft) {
  return {
    name: input.name,
    objective: input.objective,
    optimizationGoal: input.optimizationGoal,
    specialAdCategories: input.specialAdCategories,
    nameTemplate: input.nameTemplate ?? null,
    adsetNameTemplate: input.adsetNameTemplate ?? null,
    budgetMode: input.budgetMode,
    dailyBudgetCents: input.dailyBudgetCents ?? null,
    keywords: input.keywords as Prisma.InputJsonValue,
    racValue: input.racValue ?? null,
    query: input.query ?? null,
    fallbackUrl: input.fallbackUrl ?? null,
    adAccountId: input.adAccountId ?? null,
    pageId: input.pageId ?? null,
  };
}

export type CampaignWithChildren = Prisma.CampaignGetPayload<{ include: typeof campaignInclude }>;

export async function createCampaign(
  auth: AuthContext,
  input: CampaignDraft,
): Promise<CampaignWithChildren> {
  return runScoped(auth, async (tx) => {
    await assertAssetsOwned(tx, auth.userId, input);
    return tx.campaign.create({
      data: {
        orgId: auth.orgId,
        buyerId: auth.userId,
        ...campaignScalars(auth.orgId, input),
        adSets: { create: adSetCreateInputs(auth.orgId, input) },
      },
      include: campaignInclude,
    });
  });
}

export async function listCampaigns(auth: AuthContext): Promise<CampaignWithChildren[]> {
  return runScoped(auth, (tx) =>
    tx.campaign.findMany({
      // Buyers see their own; org/platform admins see everything in scope.
      where: auth.role === ROLES.MEDIA_BUYER ? { buyerId: auth.userId } : undefined,
      orderBy: { updatedAt: 'desc' },
      include: campaignInclude,
    }),
  );
}

async function loadOwnedCampaign(
  tx: TxClient,
  auth: AuthContext,
  id: string,
): Promise<CampaignWithChildren> {
  const campaign = await tx.campaign.findUnique({ where: { id }, include: campaignInclude });
  if (!campaign) throw new AppError(404, 'Campaign not found');
  if (auth.role === ROLES.MEDIA_BUYER && campaign.buyerId !== auth.userId) {
    throw new AppError(404, 'Campaign not found');
  }
  return campaign;
}

export async function getCampaign(auth: AuthContext, id: string): Promise<CampaignWithChildren> {
  return runScoped(auth, (tx) => loadOwnedCampaign(tx, auth, id));
}

export async function updateCampaign(
  auth: AuthContext,
  id: string,
  input: CampaignDraft,
): Promise<CampaignWithChildren> {
  return runScoped(auth, async (tx) => {
    const existing = await loadOwnedCampaign(tx, auth, id);
    if (existing.status !== 'DRAFT') {
      throw new AppError(409, 'Only draft campaigns can be edited');
    }
    await assertAssetsOwned(tx, auth.userId, input);
    // Wholesale-replace the ad sets/ads (the wizard submits the full current state).
    await tx.adSet.deleteMany({ where: { campaignId: id } });
    return tx.campaign.update({
      where: { id },
      data: {
        ...campaignScalars(auth.orgId, input),
        adSets: { create: adSetCreateInputs(auth.orgId, input) },
      },
      include: campaignInclude,
    });
  });
}

/** Map a stored campaign back to the draft shape for the submit-completeness check. */
function toDraft(campaign: CampaignWithChildren): CampaignDraft {
  return {
    name: campaign.name,
    objective: campaign.objective,
    optimizationGoal: campaign.optimizationGoal,
    specialAdCategories: campaign.specialAdCategories as SpecialAdCategory[],
    nameTemplate: campaign.nameTemplate ?? undefined,
    adsetNameTemplate: campaign.adsetNameTemplate ?? undefined,
    budgetMode: campaign.budgetMode,
    dailyBudgetCents: campaign.dailyBudgetCents ?? undefined,
    keywords: Array.isArray(campaign.keywords) ? (campaign.keywords as string[]) : [],
    racValue: campaign.racValue ?? undefined,
    query: campaign.query ?? undefined,
    fallbackUrl: campaign.fallbackUrl ?? undefined,
    adAccountId: campaign.adAccountId ?? undefined,
    pageId: campaign.pageId ?? undefined,
    adSets: campaign.adSets.map((set) => ({
      name: set.name,
      dailyBudgetCents: set.dailyBudgetCents ?? undefined,
      billingEvent: set.billingEvent,
      optimizationGoal: set.optimizationGoal,
      bidStrategy: set.bidStrategy ?? undefined,
      countries: set.countries,
      excludeCountries: set.excludeCountries,
      ageMin: set.ageMin,
      ageMax: set.ageMax,
      genders: set.genders as Gender[],
      languages: set.languages,
      devicePlatforms: set.devicePlatforms as DevicePlatform[],
      mobileOs: set.mobileOs as MobileOs[],
      advantageAudience: set.advantageAudience,
      placementMode: set.placementMode as PlacementMode,
      placements: set.placements,
      pixelId: set.pixelId ?? undefined,
      pxeEvent: set.pxeEvent as PxeEvent,
      conversionType: set.conversionType as ConversionType,
      costCapCents: set.costCapCents ?? undefined,
      roasFactor: set.roasFactor === null ? undefined : Number(set.roasFactor),
      attributionWindow: (set.attributionWindow as AttributionWindow | null) ?? undefined,
      startTime: set.startTime?.toISOString(),
      endTime: set.endTime?.toISOString(),
      timezone: set.timezone ?? undefined,
      ads: set.ads.map((ad) => ({
        name: ad.name,
        headline: ad.headline,
        primaryText: ad.primaryText,
        description: ad.description ?? undefined,
        cta: ad.cta as CtaOption,
        creativeType: ad.creativeType,
        uploadId: ad.uploadId ?? undefined,
        fallbackUrl: ad.fallbackUrl ?? undefined,
        beneficiary: ad.beneficiary ?? undefined,
      })),
    })),
  };
}

export async function submitCampaign(
  auth: AuthContext,
  id: string,
): Promise<CampaignWithChildren> {
  return runScoped(auth, async (tx) => {
    const campaign = await loadOwnedCampaign(tx, auth, id);
    if (campaign.status !== 'DRAFT') throw new AppError(409, 'Campaign is not a draft');
    const issues = campaignSubmitIssues(toDraft(campaign));
    if (issues.length > 0) {
      throw new AppError(422, 'Campaign is not ready to submit', issues);
    }
    return tx.campaign.update({
      where: { id },
      data: { status: 'PENDING_APPROVAL', submittedAt: new Date() },
      include: campaignInclude,
    });
  });
}

export async function deleteCampaign(auth: AuthContext, id: string): Promise<void> {
  await runScoped(auth, async (tx) => {
    const campaign = await loadOwnedCampaign(tx, auth, id);
    if (campaign.status !== 'DRAFT' && campaign.status !== 'REJECTED') {
      throw new AppError(409, 'Only draft or rejected campaigns can be deleted');
    }
    await tx.campaign.delete({ where: { id } });
  });
}
