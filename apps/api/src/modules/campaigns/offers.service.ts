import { CAMPAIGN_STATUS, type CampaignStatus, ROLES } from '@knn/shared';
import type { TxClient } from '@knn/db';
import { writeAudit } from '../../lib/audit.js';
import { enqueueOfferRebalance } from '../../lib/channel-queue.js';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { syncCampaignRedirectConfigs } from './launch.service.js';

/**
 * Campaign offers (Phase E). An offer routes a slice of a campaign's traffic to one
 * website (→ that domain's AFS pubId, Phase D) with a weight + kind (PAID gets the
 * weighted ad-traffic split; ORGANIC is the non-ad fallback destination). Each PAID
 * offer is assigned a channel from its domain's pool at approval (the worker's
 * `assignOfferChannels`). Org-scoped (RLS) via `runScoped`; a buyer manages only their
 * own campaign's offers. Editable only before approval (no channels held yet).
 */

export interface OfferRow {
  id: string;
  domainId: string;
  host: string;
  afsLabel: string | null;
  weightPct: number;
  kind: 'PAID' | 'ORGANIC';
  /** The assigned AdSense channel string (`ch`), or null until assigned at approval. */
  channelId: string | null;
  /** The domain's verify status (PENDING_DNS / VERIFYING / LIVE / ERROR). */
  domainStatus: string;
  /** Article VARIANT for this offer (A/B testing); null → the campaign's default article. */
  articleId: string | null;
  /** Display title of the article variant, when set. */
  articleTitle: string | null;
}

export interface OfferInput {
  domainId: string;
  weightPct: number;
  kind: 'PAID' | 'ORGANIC';
  /** Optional article variant (A/B): must be a READY article in the buyer's org. */
  articleId?: string | null;
}

export interface OfferDomainOption {
  id: string;
  host: string;
  afsLabel: string | null;
}

export interface ArticleVariantOption {
  id: string;
  title: string;
  slug: string;
}

/** READY articles in the buyer's org — the options for an offer's article-variant (A/B) picker. */
export async function listArticleVariants(auth: AuthContext): Promise<ArticleVariantOption[]> {
  return runScoped(auth, (tx) =>
    tx.article.findMany({
      where: { status: 'READY' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, title: true, slug: true },
    }),
  );
}

/**
 * LIVE domains a buyer can route offers to: shared domains (no owner) PLUS any
 * domain owned by the buyer's own company. Domains owned by another company are hidden.
 */
export async function listOfferDomains(auth: AuthContext): Promise<OfferDomainOption[]> {
  return runScoped(auth, async (tx) => {
    const rows = await tx.domain.findMany({
      where: { status: 'LIVE', OR: [{ ownerOrgId: null }, { ownerOrgId: auth.orgId }] },
      select: { id: true, host: true, afsAccount: { select: { label: true } } },
      orderBy: { host: 'asc' },
    });
    return rows.map((d) => ({ id: d.id, host: d.host, afsLabel: d.afsAccount.label }));
  });
}

/** Offers may be edited only before channels are assigned (i.e. before approval). */
const EDITABLE: readonly CampaignStatus[] = [
  CAMPAIGN_STATUS.DRAFT,
  CAMPAIGN_STATUS.PENDING_APPROVAL,
  CAMPAIGN_STATUS.REJECTED,
  CAMPAIGN_STATUS.QUEUED_NO_CHANNEL,
];

async function loadCampaignScoped(
  auth: AuthContext,
  tx: TxClient,
  campaignId: string,
): Promise<{ id: string; orgId: string; buyerId: string; status: CampaignStatus }> {
  const c = await tx.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, orgId: true, buyerId: true, status: true },
  });
  if (!c) throw new AppError(404, 'Campaign not found');
  if (auth.role === ROLES.MEDIA_BUYER && c.buyerId !== auth.userId) throw new AppError(404, 'Campaign not found');
  return c as { id: string; orgId: string; buyerId: string; status: CampaignStatus };
}

export async function listOffers(auth: AuthContext, campaignId: string): Promise<OfferRow[]> {
  return runScoped(auth, async (tx) => {
    await loadCampaignScoped(auth, tx, campaignId);
    const offers = await tx.offer.findMany({
      where: { campaignId },
      include: { domain: { select: { host: true, status: true, afsAccount: { select: { label: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    const refs = offers.map((o) => o.channelRef).filter((x): x is string => Boolean(x));
    const chRows = refs.length
      ? await tx.channel.findMany({ where: { id: { in: refs } }, select: { id: true, channelId: true } })
      : [];
    const chById = new Map(chRows.map((c) => [c.id, c.channelId]));
    const artIds = offers.map((o) => o.articleId).filter((x): x is string => Boolean(x));
    const artRows = artIds.length
      ? await tx.article.findMany({ where: { id: { in: artIds } }, select: { id: true, title: true } })
      : [];
    const artById = new Map(artRows.map((a) => [a.id, a.title]));
    return offers.map((o) => ({
      id: o.id,
      domainId: o.domainId,
      host: o.domain.host,
      afsLabel: o.domain.afsAccount.label,
      weightPct: o.weightPct,
      kind: o.kind,
      channelId: o.channelRef ? (chById.get(o.channelRef) ?? null) : null,
      domainStatus: o.domain.status,
      articleId: o.articleId ?? null,
      articleTitle: o.articleId ? (artById.get(o.articleId) ?? null) : null,
    }));
  });
}

/** Shape checks (no DB): at most one organic offer, and at least one weighted paid offer. */
function assertOfferShape(inputs: { kind: 'PAID' | 'ORGANIC'; weightPct: number }[]): void {
  if (inputs.filter((o) => o.kind === 'ORGANIC').length > 1) {
    throw new AppError(400, 'A campaign can have at most one organic offer');
  }
  const paid = inputs.filter((o) => o.kind === 'PAID');
  if (paid.length > 0 && !paid.some((o) => o.weightPct > 0)) {
    throw new AppError(400, 'At least one paid offer needs a weight greater than 0');
  }
}

/** DB validation: every domain is LIVE + usable by this org; every article variant is a READY org article. */
async function assertDomainsAndVariants(
  tx: TxClient,
  orgId: string,
  inputs: { domainId: string; articleId?: string | null }[],
): Promise<void> {
  for (const o of inputs) {
    const d = await tx.domain.findUnique({ where: { id: o.domainId }, select: { host: true, status: true, ownerOrgId: true } });
    if (!d) throw new AppError(400, 'Offer references an unknown domain');
    if (d.status !== 'LIVE') throw new AppError(400, `Domain ${d.host} is not LIVE yet — verify it first`);
    if (d.ownerOrgId && d.ownerOrgId !== orgId) throw new AppError(400, `Domain ${d.host} is restricted to another company`);
  }
  // RLS scopes the article query, so a foreign-org article simply won't be found.
  const variantIds = [...new Set(inputs.map((o) => o.articleId).filter((x): x is string => Boolean(x)))];
  if (variantIds.length > 0) {
    const arts = await tx.article.findMany({ where: { id: { in: variantIds } }, select: { id: true, status: true } });
    const byId = new Map(arts.map((a) => [a.id, a.status]));
    for (const id of variantIds) {
      const status = byId.get(id);
      if (!status) throw new AppError(400, 'Offer references an unknown article variant');
      if (status !== 'READY') throw new AppError(400, 'Article variant must be READY before it can serve traffic');
    }
  }
}

/** Replace a campaign's offer set (validate weights/kinds + LIVE domains; pre-approval only). */
export async function setOffers(auth: AuthContext, campaignId: string, inputs: OfferInput[]): Promise<OfferRow[]> {
  assertOfferShape(inputs);
  await runScoped(auth, async (tx) => {
    const c = await loadCampaignScoped(auth, tx, campaignId);
    if (!EDITABLE.includes(c.status)) {
      throw new AppError(409, 'Offers can only be edited before the campaign is approved');
    }
    const existing = await tx.offer.findMany({ where: { campaignId }, select: { channelRef: true } });
    if (existing.some((o) => o.channelRef)) {
      throw new AppError(409, 'Offers already hold channels — release them before editing');
    }
    await assertDomainsAndVariants(tx, c.orgId, inputs);
    await tx.offer.deleteMany({ where: { campaignId } });
    for (const o of inputs) {
      await tx.offer.create({
        data: { orgId: c.orgId, campaignId, domainId: o.domainId, weightPct: o.weightPct, kind: o.kind, articleId: o.articleId ?? null },
      });
    }
    await writeAudit(tx, {
      orgId: c.orgId,
      actorId: auth.userId,
      action: 'campaign.offers.set',
      entityType: 'campaign',
      entityId: campaignId,
      details: { count: inputs.length, paid: inputs.filter((o) => o.kind === 'PAID').length },
    });
  });
  return listOffers(auth, campaignId);
}

/** Campaign states where the campaign is past approval (channels held) and traffic routing
 *  can be re-edited LIVE — without touching Facebook (we only rewrite edge KV). */
const LIVE_EDITABLE: readonly CampaignStatus[] = [
  CAMPAIGN_STATUS.PROCESSING,
  CAMPAIGN_STATUS.LAUNCHING,
  CAMPAIGN_STATUS.BATCHED,
  CAMPAIGN_STATUS.ACTIVE,
  CAMPAIGN_STATUS.PAUSED,
];

/** An offer in a live edit: existing offers carry their `id` (kept/updated); new offers omit it. */
export interface LiveOfferInput extends OfferInput {
  id?: string;
}

export interface LiveOffersResult {
  /** True when the change needs channel assignment/release (add/remove) → routed async via the
   *  worker; the KV re-sync lands once channels settle. False = weights/variants applied + KV
   *  re-synced synchronously (takes effect on the next click). */
  rebalancing: boolean;
  offers: OfferRow[];
}

/**
 * Edit a LIVE campaign's offers without touching Facebook (OQ#9). The FB creative only
 * carries the stable `/go/{redirectId}` link, so re-routing = rewriting edge KV:
 *  - **Weights / article-variant changes on existing offers** → applied + KV re-synced
 *    synchronously (instant; takes effect on the next click).
 *  - **Add / remove offers** → channel claim/release is the worker's job (single-writer,
 *    SKIP LOCKED), so we apply the offer rows then enqueue a `rebalance` that assigns new
 *    channels, releases removed ones, and re-syncs KV.
 * Existing offers are matched by `id` (kept) so their channels are preserved.
 */
export async function updateLiveOffers(auth: AuthContext, campaignId: string, inputs: LiveOfferInput[]): Promise<LiveOffersResult> {
  assertOfferShape(inputs);

  const { added, removed } = await runScoped(auth, async (tx) => {
    const c = await loadCampaignScoped(auth, tx, campaignId);
    if (!LIVE_EDITABLE.includes(c.status)) {
      throw new AppError(409, 'This campaign is not live yet — edit its offers from the campaign before it launches');
    }
    await assertDomainsAndVariants(tx, c.orgId, inputs);

    const existing = await tx.offer.findMany({ where: { campaignId }, select: { id: true } });
    const existingIds = new Set(existing.map((o) => o.id));
    const keptIds = new Set(inputs.map((o) => o.id).filter((x): x is string => typeof x === 'string' && existingIds.has(x)));
    const removedIds = existing.filter((o) => !keptIds.has(o.id)).map((o) => o.id);

    // Update kept offers in place (preserve their channelRef); create new ones (channel TBD).
    let addedCount = 0;
    for (const o of inputs) {
      if (o.id && keptIds.has(o.id)) {
        await tx.offer.update({ where: { id: o.id }, data: { weightPct: o.weightPct, kind: o.kind, articleId: o.articleId ?? null } });
      } else {
        await tx.offer.create({ data: { orgId: c.orgId, campaignId, domainId: o.domainId, weightPct: o.weightPct, kind: o.kind, articleId: o.articleId ?? null } });
        addedCount += 1;
      }
    }
    if (removedIds.length > 0) await tx.offer.deleteMany({ where: { id: { in: removedIds } } });

    await writeAudit(tx, {
      orgId: c.orgId,
      actorId: auth.userId,
      action: 'campaign.offers.live_edit',
      entityType: 'campaign',
      entityId: campaignId,
      details: { kept: keptIds.size, added: addedCount, removed: removedIds.length },
    });
    return { added: addedCount, removed: removedIds.length };
  });

  const rebalancing = added > 0 || removed > 0;
  if (rebalancing) {
    // Channel claim (new offers) / release (removed offers) is the worker's job; it re-syncs KV after.
    await enqueueOfferRebalance(campaignId);
  } else {
    // Pure weight / article-variant change — re-sync KV now (instant, no Facebook).
    await syncCampaignRedirectConfigs(campaignId);
  }
  return { rebalancing, offers: await listOffers(auth, campaignId) };
}
