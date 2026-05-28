import { CAMPAIGN_STATUS, type CampaignStatus, ROLES } from '@knn/shared';
import type { TxClient } from '@knn/db';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';

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
}

export interface OfferInput {
  domainId: string;
  weightPct: number;
  kind: 'PAID' | 'ORGANIC';
}

export interface OfferDomainOption {
  id: string;
  host: string;
  afsLabel: string | null;
}

/** LIVE domains a buyer can route offers to (public websites; any authenticated role). */
export async function listOfferDomains(auth: AuthContext): Promise<OfferDomainOption[]> {
  return runScoped(auth, async (tx) => {
    const rows = await tx.domain.findMany({
      where: { status: 'LIVE' },
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
    return offers.map((o) => ({
      id: o.id,
      domainId: o.domainId,
      host: o.domain.host,
      afsLabel: o.domain.afsAccount.label,
      weightPct: o.weightPct,
      kind: o.kind,
      channelId: o.channelRef ? (chById.get(o.channelRef) ?? null) : null,
      domainStatus: o.domain.status,
    }));
  });
}

/** Replace a campaign's offer set (validate weights/kinds + LIVE domains; pre-approval only). */
export async function setOffers(auth: AuthContext, campaignId: string, inputs: OfferInput[]): Promise<OfferRow[]> {
  if (inputs.filter((o) => o.kind === 'ORGANIC').length > 1) {
    throw new AppError(400, 'A campaign can have at most one organic offer');
  }
  const paid = inputs.filter((o) => o.kind === 'PAID');
  if (paid.length > 0 && !paid.some((o) => o.weightPct > 0)) {
    throw new AppError(400, 'At least one paid offer needs a weight greater than 0');
  }

  await runScoped(auth, async (tx) => {
    const c = await loadCampaignScoped(auth, tx, campaignId);
    if (!EDITABLE.includes(c.status)) {
      throw new AppError(409, 'Offers can only be edited before the campaign is approved');
    }
    const existing = await tx.offer.findMany({ where: { campaignId }, select: { channelRef: true } });
    if (existing.some((o) => o.channelRef)) {
      throw new AppError(409, 'Offers already hold channels — release them before editing');
    }
    // Validate every referenced domain exists and is LIVE (don't route traffic to a dead site).
    for (const o of inputs) {
      const d = await tx.domain.findUnique({ where: { id: o.domainId }, select: { host: true, status: true } });
      if (!d) throw new AppError(400, 'Offer references an unknown domain');
      if (d.status !== 'LIVE') throw new AppError(400, `Domain ${d.host} is not LIVE yet — verify it first`);
    }
    await tx.offer.deleteMany({ where: { campaignId } });
    for (const o of inputs) {
      await tx.offer.create({ data: { orgId: c.orgId, campaignId, domainId: o.domainId, weightPct: o.weightPct, kind: o.kind } });
    }
    await writeAudit(tx, {
      orgId: c.orgId,
      actorId: auth.userId,
      action: 'campaign.offers.set',
      entityType: 'campaign',
      entityId: campaignId,
      details: { count: inputs.length, paid: paid.length },
    });
  });
  return listOffers(auth, campaignId);
}
