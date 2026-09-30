import { env } from '@knn/config';
import { FbConnectionStatus, type Prisma, type TxClient, WhopConnectionStatus, withSystem } from '@knn/db';
import {
  type AttributionWindow,
  CAMPAIGN_STATUS,
  CHANNEL_STATUS,
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
  canTransitionCampaign,
  rcBlockedMessage,
} from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { enqueueChannelAssign } from '../../lib/channel-queue.js';
import { AppError } from '../../lib/errors.js';
import { generateRedirectId } from '../../lib/ids.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import { type OfferInput, setOffers } from './offers.service.js';
import { clearWhopIds, discardWhopCampaign, whopLeftover } from './whop-cleanup.js';
import { blockedRcHits } from './rc-terms.service.js';
import type { AuthContext } from '../../middleware/authenticate.js';

export const campaignInclude = {
  adSets: { orderBy: { createdAt: 'asc' }, include: { ads: { orderBy: { createdAt: 'asc' } } } },
} satisfies Prisma.CampaignInclude;

/** The creative an ad shows: media + every text field (Google's rc = that text, verbatim). */
interface AdCreativeFields {
  creativeType: string;
  uploadId: string | null;
  headline: string;
  primaryText: string;
  description: string | null;
  cta: string;
}
export type AdRacSource = AdCreativeFields & { racValue: string | null };

function creativeKey(a: AdCreativeFields): string {
  return JSON.stringify([a.creativeType, a.uploadId ?? '', a.headline, a.primaryText, a.description ?? '', a.cta]);
}

/**
 * D27: a per-ad Referrer Ad Creative follows its CREATIVE. The draft editor and clone recreate ads
 * (new ids), so each override moves to the new ad showing the identical creative. A changed
 * creative drops it: rc must be that creative's verbatim text, so a stale one is worse than the
 * campaign default. Identical creatives are matched in order. Returns how many were carried.
 */
async function carryAdRacValues(
  tx: TxClient,
  from: readonly AdRacSource[],
  to: readonly (AdCreativeFields & { id: string })[],
): Promise<number> {
  const pool = new Map<string, string[]>();
  for (const a of from) {
    if (!a.racValue) continue;
    const k = creativeKey(a);
    pool.set(k, [...(pool.get(k) ?? []), a.racValue]);
  }
  if (pool.size === 0) return 0;
  let carried = 0;
  for (const a of to) {
    const racValue = pool.get(creativeKey(a))?.shift();
    if (!racValue) continue;
    await tx.ad.update({ where: { id: a.id }, data: { racValue } });
    carried += 1;
  }
  return carried;
}

/**
 * Resolved labels for a campaign's selected FB assets. Ad account / page live on
 * `fb_ad_accounts` / `fb_pages` with NO Prisma relation from `campaigns` (see schema comment
 * at Campaign.adAccountId — deliberately no FK so disconnect-churn can't cascade). So the read
 * paths (`getCampaign` / `listCampaigns`) enrich by id lookup in the same scoped tx: the
 * approval / review UI needs the human-readable NAMES a buyer selected, not just the ids.
 */
export interface CampaignAssetLabels {
  adAccount: { id: string; fbAccountId: string; name: string } | null;
  page: { id: string; fbPageId: string; name: string } | null;
  /** A Whop campaign's business and page (D32), resolved the same way, so a reviewer sees what the buyer picked. */
  whopBusiness: { bizId: string; label: string | null } | null;
  whopPage: { whopId: string; name: string | null } | null;
}

type AccountLabel = NonNullable<CampaignAssetLabels['adAccount']>;
type PageLabel = NonNullable<CampaignAssetLabels['page']>;

async function resolveAssetLabels(
  tx: TxClient,
  campaigns: { adAccountId: string | null; pageId: string | null }[],
): Promise<{ accounts: Map<string, AccountLabel>; pages: Map<string, PageLabel> }> {
  const accountIds = Array.from(new Set(campaigns.map((c) => c.adAccountId).filter((v): v is string => Boolean(v))));
  const pageIds = Array.from(new Set(campaigns.map((c) => c.pageId).filter((v): v is string => Boolean(v))));
  const [accounts, pages] = await Promise.all([
    accountIds.length > 0
      ? tx.fbAdAccount.findMany({
          where: { id: { in: accountIds } },
          select: { id: true, fbAccountId: true, name: true },
        })
      : Promise.resolve<AccountLabel[]>([]),
    pageIds.length > 0
      ? tx.fbPage.findMany({
          where: { id: { in: pageIds } },
          select: { id: true, fbPageId: true, name: true },
        })
      : Promise.resolve<PageLabel[]>([]),
  ]);
  return {
    accounts: new Map(accounts.map((a) => [a.id, a])),
    pages: new Map(pages.map((p) => [p.id, p])),
  };
}

/** The Whop business and page labels of the Whop campaigns among `campaigns` (one lookup each, not one per campaign). */
async function resolveWhopLabels(
  tx: TxClient,
  campaigns: { adProvider: string; whopConnectionId: string | null; whopBizId: string | null; whopPageId: string | null }[],
): Promise<{ connections: Map<string, { bizId: string; label: string | null }>; pages: Map<string, string | null> }> {
  const whop = campaigns.filter((c) => c.adProvider === 'WHOP');
  const connectionIds = [...new Set(whop.map((c) => c.whopConnectionId).filter((v): v is string => Boolean(v)))];
  const pageIds = [...new Set(whop.map((c) => c.whopPageId).filter((v): v is string => Boolean(v)))];
  const [connections, pages] = await Promise.all([
    connectionIds.length > 0 ? tx.whopConnection.findMany({ where: { id: { in: connectionIds } }, select: { id: true, bizId: true, label: true } }) : Promise.resolve([]),
    pageIds.length > 0 ? tx.whopSocialAccount.findMany({ where: { whopId: { in: pageIds }, connectionId: { in: connectionIds } }, select: { whopId: true, name: true } }) : Promise.resolve([]),
  ]);
  return { connections: new Map(connections.map((c) => [c.id, { bizId: c.bizId, label: c.label }])), pages: new Map(pages.map((p) => [p.whopId, p.name])) };
}

/** Attach `adAccount` / `page` (and, for Whop campaigns, `whopBusiness` / `whopPage`) label objects by looking up the rows. */
export async function withAssetLabels<
  T extends { adAccountId: string | null; pageId: string | null; adProvider: string; whopConnectionId: string | null; whopBizId: string | null; whopPageId: string | null },
>(tx: TxClient, campaigns: T[]): Promise<(T & CampaignAssetLabels)[]> {
  if (campaigns.length === 0) return [];
  const [{ accounts, pages }, whop] = await Promise.all([resolveAssetLabels(tx, campaigns), resolveWhopLabels(tx, campaigns)]);
  return campaigns.map((c) => {
    const isWhop = c.adProvider === 'WHOP';
    // The business id is frozen on the campaign, so the business still shows by id after its connection is gone.
    const conn = isWhop && c.whopConnectionId ? whop.connections.get(c.whopConnectionId) : undefined;
    return {
      ...c,
      adAccount: c.adAccountId ? accounts.get(c.adAccountId) ?? null : null,
      page: c.pageId ? pages.get(c.pageId) ?? null : null,
      whopBusiness: isWhop && (conn || c.whopBizId) ? { bizId: conn?.bizId ?? c.whopBizId!, label: conn?.label ?? null } : null,
      whopPage: isWhop && c.whopPageId ? { whopId: c.whopPageId, name: whop.pages.get(c.whopPageId) ?? null } : null,
    };
  });
}

/** The FB asset ids the acting user is allowed to reference (their own connection's). */
async function ownedAssetIds(
  tx: TxClient,
  userId: string,
  opts: { healthyOnly?: boolean } = {},
): Promise<{ accounts: Set<string>; pages: Set<string>; pixels: Set<string> }> {
  // A user may have several connected FB profiles — their usable assets span all of them.
  // `healthyOnly` restricts to ACTIVE connections (used by clone, so a clone never inherits a
  // reference bound to a broken/expired connection).
  const conns = await tx.fbConnection.findMany({
    where: { userId, ...(opts.healthyOnly ? { status: FbConnectionStatus.ACTIVE } : {}) },
    select: { id: true },
  });
  if (conns.length === 0) return { accounts: new Set(), pages: new Set(), pixels: new Set() };
  const connIds = conns.map((c) => c.id);
  const [accounts, pages] = await Promise.all([
    tx.fbAdAccount.findMany({ where: { connectionId: { in: connIds } }, select: { id: true } }),
    tx.fbPage.findMany({ where: { connectionId: { in: connIds } }, select: { id: true } }),
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

/**
 * A Whop campaign may reference only the acting user's own Whop connection, and a page that belongs to it; and
 * only while Whop Ads is on for the company (D32). Returns the business id to freeze on the campaign.
 */
async function assertWhopAssetsOwned(tx: TxClient, auth: { userId: string; orgId: string }, input: CampaignDraft): Promise<{ whopBizId: string | null }> {
  if (!env.WHOP_ADS_ENABLED) throw new AppError(409, "Whop Ads isn't switched on.");
  const org = await tx.organization.findUnique({ where: { id: auth.orgId }, select: { whopEnabled: true } });
  if (!org?.whopEnabled) throw new AppError(409, "Whop Ads isn't switched on for your company.");
  if (!input.whopConnectionId) return { whopBizId: null };
  const conn = await tx.whopConnection.findFirst({ where: { id: input.whopConnectionId, userId: auth.userId }, select: { id: true, bizId: true } });
  if (!conn) throw new AppError(400, 'Selected Whop business is not connected to your account');
  if (input.whopPageId) {
    // A Facebook page specifically: Whop's launch gate is "Connect a Facebook page" (an Instagram account does not satisfy it).
    const page = await tx.whopSocialAccount.findFirst({ where: { connectionId: conn.id, whopId: input.whopPageId, platform: 'facebook' }, select: { id: true } });
    if (!page) throw new AppError(400, 'Selected page is not a Facebook page of that Whop business');
  }
  return { whopBizId: conn.bizId };
}

/** Reject any selected FB asset that isn't one of the acting user's synced assets. */
async function assertAssetsOwned(tx: TxClient, auth: { userId: string; orgId: string }, input: CampaignDraft): Promise<{ whopBizId: string | null }> {
  if (input.adProvider === 'WHOP') return assertWhopAssetsOwned(tx, auth, input);
  const userId = auth.userId;
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
  return { whopBizId: null };
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
    // A Whop campaign has no Facebook pixel: Whop owns the pixel (D32).
    pixelId: input.adProvider === 'WHOP' ? null : set.pixelId ?? null,
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
        // Headline/primary text are optional (FB doesn't require them); columns are non-null → store ''.
        headline: ad.headline ?? '',
        primaryText: ad.primaryText ?? '',
        description: ad.description,
        cta: ad.cta,
        displayLink: ad.displayLink,
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
// Each provider's assets are cleared on the other's campaigns: a Whop campaign has no Facebook ad account, page or
// pixel, and a Facebook campaign has no Whop ids, so "no Facebook ids" can never be a half-configured Facebook row.
function campaignScalars(_orgId: string, input: CampaignDraft, whopBizId: string | null = null) {
  const whop = input.adProvider === 'WHOP';
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
    adProvider: input.adProvider,
    adAccountId: whop ? null : input.adAccountId ?? null,
    pageId: whop ? null : input.pageId ?? null,
    whopConnectionId: whop ? input.whopConnectionId ?? null : null,
    whopPageId: whop ? input.whopPageId ?? null : null,
    whopBizId: whop ? whopBizId : null,
  };
}

export type CampaignWithChildren = Prisma.CampaignGetPayload<{ include: typeof campaignInclude }> &
  Partial<CampaignAssetLabels>;

export async function createCampaign(
  auth: AuthContext,
  input: CampaignDraft,
): Promise<CampaignWithChildren> {
  return runScoped(auth, async (tx) => {
    const { whopBizId } = await assertAssetsOwned(tx, auth, input);
    return tx.campaign.create({
      data: {
        orgId: auth.orgId,
        buyerId: auth.userId,
        ...campaignScalars(auth.orgId, input, whopBizId),
        adSets: { create: adSetCreateInputs(auth.orgId, input) },
      },
      include: campaignInclude,
    });
  });
}

export async function listCampaigns(auth: AuthContext): Promise<CampaignWithChildren[]> {
  return runScoped(auth, async (tx) => {
    const rows = await tx.campaign.findMany({
      // Buyers see their own; org/platform admins see everything in scope.
      where: auth.role === ROLES.MEDIA_BUYER ? { buyerId: auth.userId } : undefined,
      orderBy: { updatedAt: 'desc' },
      include: campaignInclude,
    });
    return withAssetLabels(tx, rows);
  });
}

export async function loadOwnedCampaign(
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
  return runScoped(auth, async (tx) => {
    const campaign = await loadOwnedCampaign(tx, auth, id);
    const [enriched] = await withAssetLabels(tx, [campaign]);
    return enriched ?? campaign;
  });
}

/** Load a source campaign (owner-scoped) → its draft + offer inputs, for clone/bulk-clone. */
async function buildCloneSource(
  auth: AuthContext,
  id: string,
): Promise<{ draft: CampaignDraft; offerInputs: OfferInput[]; termsOverride: string[]; sourceAds: AdRacSource[] }> {
  return runScoped(auth, async (tx) => {
    const source = await loadOwnedCampaign(tx, auth, id);
    const offers = await tx.offer.findMany({
      where: { campaignId: source.id },
      orderBy: { createdAt: 'asc' },
      select: { domainId: true, weightPct: true, kind: true, articleId: true },
    });

    // #2: a clone must be INDEPENDENT of the source's account-bound references. The source's
    // ad account / page / pixel are copied only if they still belong to a HEALTHY (active)
    // connection; anything bound to a broken/expired/removed connection is dropped so the clone
    // never carries a dead dependency — the buyer re-selects a live asset in the wizard. (FB
    // campaign/ad-set/ad ids, channel, and status are already not copied — clone is a fresh DRAFT.)
    const draftRaw = toDraft(source);
    let draft: CampaignDraft;
    if (draftRaw.adProvider === 'WHOP') {
      // Same rule for a Whop source (D32): keep the business only while its connection is healthy, and the page
      // only while that business still has it. A Whop campaign has no Facebook ad account, page or pixel.
      const conn = draftRaw.whopConnectionId
        ? await tx.whopConnection.findFirst({
            where: { id: draftRaw.whopConnectionId, userId: auth.userId, status: WhopConnectionStatus.ACTIVE },
            select: { id: true, socialAccounts: { select: { whopId: true } } },
          })
        : null;
      const pageStillThere = Boolean(conn && draftRaw.whopPageId && conn.socialAccounts.some((p) => p.whopId === draftRaw.whopPageId));
      draft = {
        ...draftRaw,
        whopConnectionId: conn?.id,
        whopPageId: pageStillThere ? draftRaw.whopPageId : undefined,
        adSets: draftRaw.adSets.map((set) => ({ ...set, pixelId: undefined })),
      };
    } else {
      const healthy = await ownedAssetIds(tx, auth.userId, { healthyOnly: true });
      draft = {
        ...draftRaw,
        adAccountId: draftRaw.adAccountId && healthy.accounts.has(draftRaw.adAccountId) ? draftRaw.adAccountId : undefined,
        pageId: draftRaw.pageId && healthy.pages.has(draftRaw.pageId) ? draftRaw.pageId : undefined,
        adSets: draftRaw.adSets.map((set) => ({
          ...set,
          pixelId: set.pixelId && healthy.pixels.has(set.pixelId) ? set.pixelId : undefined,
        })),
      };
    }

    return {
      draft,
      offerInputs: offers.map(
        (o): OfferInput => ({ domainId: o.domainId, weightPct: o.weightPct, kind: o.kind, articleId: o.articleId }),
      ),
      // D27: the buyer's custom RSOC terms are campaign config (like keywords) → the clone keeps
      // them; per-ad rc follows each (identical) creative onto the clone's ads.
      termsOverride: source.termsOverride,
      sourceAds: source.adSets.flatMap((s) => s.ads),
    };
  });
}

/** Create one DRAFT from a (already-built) draft + offers — fresh redirect ids, offers copied. */
async function materializeClone(
  auth: AuthContext,
  draft: CampaignDraft,
  offerInputs: OfferInput[],
  termsOverride: string[] = [],
  sourceAds: readonly AdRacSource[] = [],
): Promise<CampaignWithChildren> {
  let created = await createCampaign(auth, draft);
  if (termsOverride.length > 0 || sourceAds.some((a) => a.racValue)) {
    created = await runScoped(auth, async (tx) => {
      if (termsOverride.length > 0) await tx.campaign.update({ where: { id: created.id }, data: { termsOverride } });
      await carryAdRacValues(tx, sourceAds, created.adSets.flatMap((s) => s.ads));
      return tx.campaign.findUniqueOrThrow({ where: { id: created.id }, include: campaignInclude });
    });
  }
  if (offerInputs.length === 0) return created;
  // setOffers re-validates each offer (a source domain may have changed status since).
  await setOffers(auth, created.id, offerInputs);
  return getCampaign(auth, created.id);
}

/**
 * Clone a campaign into a fresh editable DRAFT owned by the actor: same objective / budget /
 * targeting / ad sets / ads (each ad gets a BRAND-NEW redirectId via createCampaign) and the
 * same offers (websites / weights / article variants). The clone carries NO Facebook or
 * channel state — it's a clean draft to tweak and submit. Owner-scoped like every campaign op.
 */
export async function cloneCampaign(auth: AuthContext, id: string): Promise<CampaignWithChildren> {
  const { draft, offerInputs, termsOverride, sourceAds } = await buildCloneSource(auth, id);
  return materializeClone(auth, { ...draft, name: `${draft.name} (copy)` }, offerInputs, termsOverride, sourceAds);
}

/**
 * Bulk generator: clone a campaign into N fresh DRAFTs ("X (copy 1)" … "X (copy N)"), each with
 * its own redirect ids + copied offers — the "duplicate to make variations" workflow. The
 * source is read once; N is clamped to 1–20. Owner-scoped.
 */
export async function bulkCloneCampaign(
  auth: AuthContext,
  id: string,
  count: number,
): Promise<CampaignWithChildren[]> {
  const n = Math.min(Math.max(Math.trunc(count) || 0, 1), 20);
  const { draft, offerInputs, termsOverride, sourceAds } = await buildCloneSource(auth, id);
  const created: CampaignWithChildren[] = [];
  for (let i = 1; i <= n; i += 1) {
    // Sequential (not Promise.all): each clone claims fresh redirect ids; keep DB load bounded.
    created.push(await materializeClone(auth, { ...draft, name: `${draft.name} (copy ${i})` }, offerInputs, termsOverride, sourceAds));
  }
  return created;
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
    const { whopBizId } = await assertAssetsOwned(tx, auth, input);
    // Wholesale-replace the ad sets/ads (the wizard submits the full current state).
    const previousAds = existing.adSets.flatMap((s) => s.ads);
    await tx.adSet.deleteMany({ where: { campaignId: id } });
    const updated = await tx.campaign.update({
      where: { id },
      data: {
        ...campaignScalars(auth.orgId, input, whopBizId),
        adSets: { create: adSetCreateInputs(auth.orgId, input) },
      },
      include: campaignInclude,
    });
    // Per-ad rc overrides survive a draft save for every ad whose creative is unchanged (D27).
    const carried = await carryAdRacValues(tx, previousAds, updated.adSets.flatMap((s) => s.ads));
    return carried ? tx.campaign.findUniqueOrThrow({ where: { id }, include: campaignInclude }) : updated;
  });
}

/** Map a stored campaign back to the draft shape for the submit-completeness check. */
export function toDraft(campaign: CampaignWithChildren): CampaignDraft {
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
    adProvider: campaign.adProvider,
    adAccountId: campaign.adAccountId ?? undefined,
    pageId: campaign.pageId ?? undefined,
    whopConnectionId: campaign.whopConnectionId ?? undefined,
    whopPageId: campaign.whopPageId ?? undefined,
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
        displayLink: ad.displayLink ?? undefined,
        creativeType: ad.creativeType,
        uploadId: ad.uploadId ?? undefined,
        fallbackUrl: ad.fallbackUrl ?? undefined,
        beneficiary: ad.beneficiary ?? undefined,
      })),
    })),
  };
}

/**
 * A Whop campaign can only be submitted while its Whop business is usable (D32): Whop Ads is on for the company
 * and the connection exists and works. Deliberately NOT the connection's `canLaunch` checklist: a missing payment
 * method or page is something Whop tells the buyer at launch, in its own words, and the buyer can fix it in Whop
 * after approval without the campaign having to go back through review.
 */
async function whopSubmitProblem(tx: TxClient, c: { orgId: string; whopConnectionId: string | null }): Promise<string | null> {
  if (!env.WHOP_ADS_ENABLED) return "Whop Ads isn't switched on.";
  const org = await tx.organization.findUnique({ where: { id: c.orgId }, select: { whopEnabled: true } });
  if (!org?.whopEnabled) return "Whop Ads isn't switched on for your company.";
  const conn = c.whopConnectionId ? await tx.whopConnection.findUnique({ where: { id: c.whopConnectionId }, select: { status: true } }) : null;
  if (!conn) return 'The Whop business for this campaign is no longer connected. Pick one again.';
  if (conn.status !== WhopConnectionStatus.ACTIVE) return 'This Whop connection needs attention. Reconnect it in Settings → Whop.';
  return null;
}

/**
 * Submit a complete draft for review (DRAFT → PENDING_APPROVAL). If the buyer's
 * org has auto-approve on, the submission is approved in the same step (modeled
 * as submit + immediate system approval — both state-machine edges are valid, so
 * the graph needs no synthetic DRAFT → APPROVED edge). Writes an audit entry and,
 * on auto-approval, notifies the buyer after commit.
 */
export async function submitCampaign(
  auth: AuthContext,
  id: string,
): Promise<CampaignWithChildren> {
  let autoLaunch = false;
  const { campaign, autoApproved } = await runScoped(auth, async (tx) => {
    const existing = await loadOwnedCampaign(tx, auth, id);
    if (!canTransitionCampaign(existing.status, CAMPAIGN_STATUS.PENDING_APPROVAL)) {
      throw new AppError(409, 'Campaign is not a draft');
    }
    const issues = campaignSubmitIssues(toDraft(existing));
    if (existing.adProvider === 'WHOP') {
      const problem = await whopSubmitProblem(tx, existing);
      if (problem) issues.push(problem);
    }
    // A campaign monetizes through its offers (the websites it routes to). Without at
    // least one PAID offer it has no destination + no channel to assign, so it would
    // hang in QUEUED_NO_CHANNEL after approval — block it at submit with a clear reason.
    const paidOffers = await tx.offer.count({ where: { campaignId: id, kind: 'PAID' } });
    if (paidOffers === 0) {
      issues.push('Add at least one paid offer (a website to send traffic to) before submitting');
    }
    // D28: an rc with a word that makes Google hide the keyword block can't go live.
    const rcHits = await blockedRcHits([existing.racValue, ...existing.adSets.flatMap((s) => s.ads.map((a) => a.racValue))]);
    if (rcHits.length > 0) issues.push(rcBlockedMessage(rcHits));
    if (issues.length > 0) {
      throw new AppError(422, 'Campaign is not ready to submit', issues);
    }

    const org = await tx.organization.findUnique({
      where: { id: existing.orgId },
      select: { autoApprove: true, autoLaunch: true },
    });
    const auto = org?.autoApprove ?? false;
    autoLaunch = org?.autoLaunch ?? false;
    const now = new Date();
    const updated = await tx.campaign.update({
      where: { id },
      data: auto
        ? {
            status: CAMPAIGN_STATUS.APPROVED,
            submittedAt: now,
            reviewedAt: now,
            reviewedById: null,
            rejectionReason: null,
          }
        : { status: CAMPAIGN_STATUS.PENDING_APPROVAL, submittedAt: now },
      include: campaignInclude,
    });
    await writeAudit(tx, {
      orgId: existing.orgId,
      actorId: auth.userId,
      action: auto ? 'campaign.auto_approved' : 'campaign.submitted',
      entityType: 'campaign',
      entityId: id,
    });
    return { campaign: updated, autoApproved: auto };
  });

  if (autoApproved) {
    await notify({
      orgId: campaign.orgId,
      userId: campaign.buyerId,
      type: 'campaign.approved',
      title: 'Campaign approved',
      body: autoLaunch
        ? `"${campaign.name}" was auto-approved and will launch automatically once a channel is assigned.`
        : `"${campaign.name}" was auto-approved and is ready to launch once a channel is assigned.`,
    });
    await enqueueChannelAssign(campaign.id);
  }
  return campaign;
}

/**
 * Reopen a submitted/rejected campaign back to an editable DRAFT — i.e. withdraw
 * a PENDING_APPROVAL submission or revise a REJECTED one (both are legal moves to
 * DRAFT in the state machine). Clears the review trail so it's a clean draft again.
 */
export async function reopenCampaign(
  auth: AuthContext,
  id: string,
): Promise<CampaignWithChildren> {
  // Reopen to an editable DRAFT. For a campaign that already grabbed channels
  // (PROCESSING/BATCHED/QUEUED), release them back to the pool so editing + a fresh
  // approval re-assigns cleanly. Only pre-launch states reach DRAFT (state machine);
  // an ACTIVE/LAUNCHING campaign can't be reopened (it'd orphan the FB campaign).
  const channelIds: string[] = [];
  const { result, leftover } = await runScoped(auth, async (tx) => {
    const campaign = await loadOwnedCampaign(tx, auth, id);
    if (!canTransitionCampaign(campaign.status, CAMPAIGN_STATUS.DRAFT)) {
      throw new AppError(409, `Cannot reopen a campaign in ${campaign.status} state`);
    }
    // Conditional on the status we just read: a launch that claimed the campaign between the read and this write
    // (PROCESSING -> LAUNCHING) must not be reopened underneath itself, or it would finish ACTIVE with no channel.
    const flipped = await tx.campaign.updateMany({
      where: { id, status: campaign.status },
      data: {
        status: CAMPAIGN_STATUS.DRAFT,
        channelId: null,
        submittedAt: null,
        reviewedAt: null,
        reviewedById: null,
        rejectionReason: null,
      },
    });
    if (flipped.count === 0) throw new AppError(409, 'The campaign changed while it was being reopened. Check it, then try again.');
    // A Whop campaign (D32): a draft must not reference Whop objects, so forget them here, in the same transaction, and
    // delete the Whop campaign once this commits (see whop-cleanup.ts). Clearing ALWAYS moves the campaign to its next key
    // epoch, even when no Whop id was saved: a create that reached Whop but whose answer was lost is replayed by Whop for 24 h
    // under the old key, and would hand the OLD campaign (old budget, old objective) back to the edited draft.
    const leftover = whopLeftover(campaign);
    if (campaign.adProvider === 'WHOP') await clearWhopIds(tx, id);
    if (campaign.channelId) channelIds.push(campaign.channelId);
    const offers = await tx.offer.findMany({ where: { campaignId: id }, select: { channelRef: true } });
    for (const o of offers) if (o.channelRef) channelIds.push(o.channelRef);
    // Detach channels from the campaign + its offers.
    await tx.offer.updateMany({ where: { campaignId: id, channelRef: { not: null } }, data: { channelRef: null } });
    const updated = await tx.campaign.findUniqueOrThrow({ where: { id }, include: campaignInclude });
    await writeAudit(tx, {
      orgId: campaign.orgId,
      actorId: auth.userId,
      action: 'campaign.reopened',
      entityType: 'campaign',
      entityId: id,
      details: { releasedChannels: channelIds.length, ...(leftover ? { whopCampaignId: leftover.whopCampaignId } : {}) },
    });
    return { result: updated, leftover };
  });
  // Channels are global (no org_id) → release them under withSystem, back to the pool.
  // `lockedForDay` is kept so the pool's same-day cooldown (D25) applies here too.
  if (channelIds.length > 0) {
    await withSystem((tx) =>
      tx.channel.updateMany({
        where: { id: { in: channelIds } },
        data: { status: CHANNEL_STATUS.AVAILABLE, currentCampaignId: null, assignedAt: null },
      }),
    );
  }
  // Released FIRST: the Whop delete below can take a while (its client retries), and a channel must not be held meanwhile.
  if (leftover) await discardWhopCampaign(leftover, auth.userId);
  return result;
}

export async function deleteCampaign(auth: AuthContext, id: string): Promise<void> {
  const leftover = await runScoped(auth, async (tx) => {
    const campaign = await loadOwnedCampaign(tx, auth, id);
    if (campaign.status !== 'DRAFT' && campaign.status !== 'REJECTED') {
      throw new AppError(409, 'Only draft or rejected campaigns can be deleted');
    }
    await tx.campaign.delete({ where: { id } });
    // Normally none (reopening already discards them); defence in depth so a delete never strands a Whop campaign.
    return whopLeftover(campaign);
  });
  if (leftover) await discardWhopCampaign(leftover, auth.userId);
}
