import { FbConnectionStatus, type Prisma, type TxClient, withSystem } from '@knn/db';
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
} from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { enqueueChannelAssign } from '../../lib/channel-queue.js';
import { AppError } from '../../lib/errors.js';
import { generateRedirectId } from '../../lib/ids.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import { type OfferInput, setOffers } from './offers.service.js';
import type { AuthContext } from '../../middleware/authenticate.js';

export const campaignInclude = {
  adSets: { orderBy: { createdAt: 'asc' }, include: { ads: { orderBy: { createdAt: 'asc' } } } },
} satisfies Prisma.CampaignInclude;

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

/** Attach `adAccount` / `page` label objects to each campaign by looking up the fb_* rows. */
export async function withAssetLabels<T extends { adAccountId: string | null; pageId: string | null }>(
  tx: TxClient,
  campaigns: T[],
): Promise<(T & CampaignAssetLabels)[]> {
  if (campaigns.length === 0) return [];
  const { accounts, pages } = await resolveAssetLabels(tx, campaigns);
  return campaigns.map((c) => ({
    ...c,
    adAccount: c.adAccountId ? accounts.get(c.adAccountId) ?? null : null,
    page: c.pageId ? pages.get(c.pageId) ?? null : null,
  }));
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

export type CampaignWithChildren = Prisma.CampaignGetPayload<{ include: typeof campaignInclude }> &
  Partial<CampaignAssetLabels>;

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
): Promise<{ draft: CampaignDraft; offerInputs: OfferInput[] }> {
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
    const healthy = await ownedAssetIds(tx, auth.userId, { healthyOnly: true });
    const draft: CampaignDraft = {
      ...draftRaw,
      adAccountId: draftRaw.adAccountId && healthy.accounts.has(draftRaw.adAccountId) ? draftRaw.adAccountId : undefined,
      pageId: draftRaw.pageId && healthy.pages.has(draftRaw.pageId) ? draftRaw.pageId : undefined,
      adSets: draftRaw.adSets.map((set) => ({
        ...set,
        pixelId: set.pixelId && healthy.pixels.has(set.pixelId) ? set.pixelId : undefined,
      })),
    };

    return {
      draft,
      offerInputs: offers.map(
        (o): OfferInput => ({ domainId: o.domainId, weightPct: o.weightPct, kind: o.kind, articleId: o.articleId }),
      ),
    };
  });
}

/** Create one DRAFT from a (already-built) draft + offers — fresh redirect ids, offers copied. */
async function materializeClone(
  auth: AuthContext,
  draft: CampaignDraft,
  offerInputs: OfferInput[],
): Promise<CampaignWithChildren> {
  const created = await createCampaign(auth, draft);
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
  const { draft, offerInputs } = await buildCloneSource(auth, id);
  return materializeClone(auth, { ...draft, name: `${draft.name} (copy)` }, offerInputs);
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
  const { draft, offerInputs } = await buildCloneSource(auth, id);
  const created: CampaignWithChildren[] = [];
  for (let i = 1; i <= n; i += 1) {
    // Sequential (not Promise.all): each clone claims fresh redirect ids; keep DB load bounded.
    created.push(await materializeClone(auth, { ...draft, name: `${draft.name} (copy ${i})` }, offerInputs));
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
    // A campaign monetizes through its offers (the websites it routes to). Without at
    // least one PAID offer it has no destination + no channel to assign, so it would
    // hang in QUEUED_NO_CHANNEL after approval — block it at submit with a clear reason.
    const paidOffers = await tx.offer.count({ where: { campaignId: id, kind: 'PAID' } });
    if (paidOffers === 0) {
      issues.push('Add at least one paid offer (a website to send traffic to) before submitting');
    }
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
  const result = await runScoped(auth, async (tx) => {
    const campaign = await loadOwnedCampaign(tx, auth, id);
    if (!canTransitionCampaign(campaign.status, CAMPAIGN_STATUS.DRAFT)) {
      throw new AppError(409, `Cannot reopen a campaign in ${campaign.status} state`);
    }
    if (campaign.channelId) channelIds.push(campaign.channelId);
    const offers = await tx.offer.findMany({ where: { campaignId: id }, select: { channelRef: true } });
    for (const o of offers) if (o.channelRef) channelIds.push(o.channelRef);
    // Detach channels from the campaign + its offers.
    await tx.offer.updateMany({ where: { campaignId: id, channelRef: { not: null } }, data: { channelRef: null } });
    const updated = await tx.campaign.update({
      where: { id },
      data: {
        status: CAMPAIGN_STATUS.DRAFT,
        channelId: null,
        submittedAt: null,
        reviewedAt: null,
        reviewedById: null,
        rejectionReason: null,
      },
      include: campaignInclude,
    });
    await writeAudit(tx, {
      orgId: campaign.orgId,
      actorId: auth.userId,
      action: 'campaign.reopened',
      entityType: 'campaign',
      entityId: id,
      details: { releasedChannels: channelIds.length },
    });
    return updated;
  });
  // Channels are global (no org_id) → release them under withSystem, back to the pool.
  if (channelIds.length > 0) {
    await withSystem((tx) =>
      tx.channel.updateMany({
        where: { id: { in: channelIds } },
        data: { status: CHANNEL_STATUS.AVAILABLE, currentCampaignId: null, lockedForDay: null, assignedAt: null },
      }),
    );
  }
  return result;
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
