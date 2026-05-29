import { type TxClient, withSystem } from '@knn/db';
import { CAMPAIGN_STATUS, type CampaignStatus, canTransitionCampaign, currentBusinessDay } from '@knn/shared';

/**
 * Channel pool & assignment (D7/D11). A global pool of AdSense AFS channels is
 * assigned 1:1 to campaigns. The assignment grabs a free channel with
 * `SELECT … FOR UPDATE SKIP LOCKED` so 100 concurrent approvals each take a
 * DISTINCT channel — zero double-assignment (the Phase 6 stress-test gate). All
 * ops run under `withSystem` (the pool is platform-global, spanning orgs).
 *
 * Time is the IST business day (D4): a channel is locked for the day; the midnight
 * cron releases channels from ended campaigns, renews active locks (per-day
 * attribution spans for Phase 9), and drains the FIFO wait queue.
 */

/** Campaign states that legitimately hold a channel; anything else releases it. */
const HOLDING_STATUSES: readonly CampaignStatus[] = [
  CAMPAIGN_STATUS.PROCESSING,
  CAMPAIGN_STATUS.LAUNCHING,
  CAMPAIGN_STATUS.ACTIVE,
  CAMPAIGN_STATUS.BATCHED,
];

export interface AssignResult {
  assigned: boolean;
  /** The single channel (legacy / non-offer campaigns). */
  channelRef?: string;
  /** The per-offer channels (Phase E offers campaigns) — one per PAID offer. */
  channelRefs?: string[];
}

/** Internal sentinel: a PAID offer's domain pool was exhausted → roll back + queue. */
class OfferPoolExhausted extends Error {}

/**
 * Optional hook fired (best-effort) right after a campaign acquires a channel —
 * the auto-launch trigger (Phase 8) wires `triggerAutoLaunch` here so a freshly
 * assigned campaign in an auto-launch org goes live without a manual step. Runs
 * for queue-drained and rollover assignments; the direct `assignChannel` caller
 * (the worker's `assign` handler) fires it itself. Fire-and-forget — the return
 * value is awaited but ignored, and a throw is caught (never blocks draining).
 */
export type OnAssigned = (campaignId: string) => unknown;

/**
 * Assign a free channel to a campaign, atomically. Returns `{assigned:true}` with
 * the channel row id, or `{assigned:false}` after enqueuing the campaign
 * (QUEUED_NO_CHANNEL) when the pool is exhausted. Idempotent: a campaign that
 * already holds a channel is returned as-is.
 */
export async function assignChannel(campaignId: string): Promise<AssignResult> {
  return withSystem(async (tx) => {
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, orgId: true, status: true, channelId: true },
    });
    if (!campaign) return { assigned: false };
    if (campaign.channelId) return { assigned: true, channelRef: campaign.channelId };

    const day = currentBusinessDay();
    // Atomically claim one available GLOBAL channel (domain_id IS NULL); concurrent claims
    // skip locked rows. Domain-tagged channels are reserved for per-offer assignment (Phase E)
    // so a legacy single-channel campaign can't grab a specific website's allocation.
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM channels WHERE status = 'AVAILABLE' AND domain_id IS NULL
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const claimed = rows[0];

    if (!claimed) {
      await tx.campaignQueue.upsert({
        where: { campaignId },
        create: { orgId: campaign.orgId, campaignId, status: 'WAITING' },
        update: { status: 'WAITING' },
      });
      if (canTransitionCampaign(campaign.status, CAMPAIGN_STATUS.QUEUED_NO_CHANNEL)) {
        await tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.QUEUED_NO_CHANNEL } });
      }
      return { assigned: false };
    }

    await tx.channel.update({
      where: { id: claimed.id },
      data: { status: 'ASSIGNED', currentCampaignId: campaignId, lockedForDay: day, assignedAt: new Date() },
    });
    await tx.channelAssignment.create({
      data: { orgId: campaign.orgId, channelRef: claimed.id, campaignId, forDay: day },
    });
    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        channelId: claimed.id,
        ...(canTransitionCampaign(campaign.status, CAMPAIGN_STATUS.PROCESSING)
          ? { status: CAMPAIGN_STATUS.PROCESSING }
          : {}),
      },
    });
    await tx.campaignQueue.updateMany({
      where: { campaignId },
      data: { status: 'ASSIGNED', assignedAt: new Date() },
    });
    return { assigned: true, channelRef: claimed.id };
  });
}

/**
 * Per-offer channel assignment (Phase E). A campaign's PAID offers each get a channel
 * from THEIR OWN domain's allocation, so AFS revenue attributes per offer/website. Claims
 * are atomic + concurrency-safe (`FOR UPDATE SKIP LOCKED` per domain pool) and
 * **all-or-nothing**: if any PAID offer's domain pool is exhausted, the whole txn rolls
 * back and the campaign is queued (QUEUED_NO_CHANNEL) — never partially assigned.
 * Idempotent: offers that already hold a channel are left untouched.
 */
export async function assignOfferChannels(campaignId: string): Promise<AssignResult> {
  try {
    return await withSystem(async (tx) => {
      const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, select: { orgId: true, status: true } });
      if (!campaign) return { assigned: false };

      const paidOffers = await tx.offer.findMany({ where: { campaignId, kind: 'PAID' }, select: { id: true, domainId: true, channelRef: true } });
      if (paidOffers.length === 0) return { assigned: false };
      const needing = paidOffers.filter((o) => !o.channelRef);
      if (needing.length === 0) return { assigned: true, channelRefs: paidOffers.map((o) => o.channelRef!).filter(Boolean) };

      const day = currentBusinessDay();
      const claimedRefs: string[] = [];
      for (const offer of needing) {
        // Atomically claim one available channel FROM THIS OFFER'S DOMAIN; concurrent
        // claims skip each other's locked rows (zero double-assignment across offers).
        const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM channels WHERE status = 'AVAILABLE' AND domain_id = $1::uuid
           ORDER BY created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED LIMIT 1`,
          offer.domainId,
        );
        const claimed = rows[0];
        if (!claimed) throw new OfferPoolExhausted(); // roll back every claim in this txn
        await tx.channel.update({
          where: { id: claimed.id },
          data: { status: 'ASSIGNED', currentCampaignId: campaignId, lockedForDay: day, assignedAt: new Date() },
        });
        await tx.channelAssignment.create({ data: { orgId: campaign.orgId, channelRef: claimed.id, campaignId, forDay: day } });
        await tx.offer.update({ where: { id: offer.id }, data: { channelRef: claimed.id } });
        claimedRefs.push(claimed.id);
      }
      if (canTransitionCampaign(campaign.status, CAMPAIGN_STATUS.PROCESSING)) {
        await tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.PROCESSING } });
      }
      await tx.campaignQueue.updateMany({ where: { campaignId }, data: { status: 'ASSIGNED', assignedAt: new Date() } });
      return { assigned: true, channelRefs: claimedRefs };
    });
  } catch (err) {
    if (!(err instanceof OfferPoolExhausted)) throw err;
    // A domain pool was exhausted → the assign txn rolled back; enqueue for a retry.
    await withSystem(async (tx) => {
      const c = await tx.campaign.findUnique({ where: { id: campaignId }, select: { orgId: true, status: true } });
      if (!c) return;
      await tx.campaignQueue.upsert({ where: { campaignId }, create: { orgId: c.orgId, campaignId, status: 'WAITING' }, update: { status: 'WAITING' } });
      if (canTransitionCampaign(c.status, CAMPAIGN_STATUS.QUEUED_NO_CHANNEL)) {
        await tx.campaign.update({ where: { id: campaignId }, data: { status: CAMPAIGN_STATUS.QUEUED_NO_CHANNEL } });
      }
    });
    return { assigned: false };
  }
}

/**
 * Dispatch assignment by campaign shape: a campaign with PAID offers (Phase E) gets a
 * channel per offer from each offer's domain pool; a legacy campaign gets one channel
 * from the global pool. Both paths are concurrency-safe and idempotent.
 */
export async function assignForCampaign(campaignId: string): Promise<AssignResult> {
  const paidCount = await withSystem((tx) => tx.offer.count({ where: { campaignId, kind: 'PAID' } }));
  return paidCount > 0 ? assignOfferChannels(campaignId) : assignChannel(campaignId);
}

/**
 * Release one channel row → AVAILABLE: close its open attribution span, clear the offer
 * that pointed at it (Phase E) and the legacy `campaign.channelId` that held it. Used by
 * both the explicit release path and the midnight rollover (per channel).
 */
async function releaseChannelRow(tx: TxClient, channelId: string): Promise<void> {
  await tx.channel.update({
    where: { id: channelId },
    data: { status: 'AVAILABLE', currentCampaignId: null, lockedForDay: null, assignedAt: null },
  });
  await tx.channelAssignment.updateMany({ where: { channelRef: channelId, releasedAt: null }, data: { releasedAt: new Date() } });
  await tx.offer.updateMany({ where: { channelRef: channelId }, data: { channelRef: null } });
  await tx.campaign.updateMany({ where: { channelId }, data: { channelId: null } });
}

/** Release EVERY channel a campaign holds (legacy single + all offer channels). */
async function releaseAllForCampaign(tx: TxClient, campaignId: string): Promise<boolean> {
  const held = await tx.channel.findMany({ where: { currentCampaignId: campaignId }, select: { id: true } });
  for (const ch of held) await releaseChannelRow(tx, ch.id);
  // Defensive: clear a dangling legacy ref even if its channel row was already freed.
  await tx.campaign.updateMany({ where: { id: campaignId }, data: { channelId: null } });
  return held.length > 0;
}

/** Release a campaign's channel(s), then hand the freed channel(s) to the next waiter(s). */
export async function releaseChannelForCampaign(
  campaignId: string,
  onAssigned?: OnAssigned,
): Promise<{ released: boolean }> {
  const released = await withSystem((tx) => releaseAllForCampaign(tx, campaignId));
  if (released) await processQueue(onAssigned);
  return { released };
}

/**
 * Live offer rebalance (OQ#9): for a campaign whose offer set just changed post-launch,
 * (1) release channels orphaned by REMOVED offers (held by this campaign but no offer points
 * to them), (2) assign channels to NEWLY-ADDED paid offers (idempotent, SKIP-LOCKED, and
 * status-safe on a live ACTIVE campaign — the PROCESSING transition is rejected so status is
 * untouched), (3) re-drive the wait queue for any freed channels. The caller re-syncs KV
 * afterward. Never touches Facebook.
 */
export async function rebalanceOfferChannels(campaignId: string): Promise<{ released: number; assigned: boolean }> {
  const released = await withSystem(async (tx) => {
    const offers = await tx.offer.findMany({ where: { campaignId }, select: { channelRef: true } });
    const keep = new Set(offers.map((o) => o.channelRef).filter((x): x is string => Boolean(x)));
    const held = await tx.channel.findMany({ where: { currentCampaignId: campaignId }, select: { id: true } });
    const orphans = held.filter((c) => !keep.has(c.id));
    for (const c of orphans) await releaseChannelRow(tx, c.id);
    return orphans.length;
  });
  const result = await assignOfferChannels(campaignId);
  if (released > 0) await processQueue();
  return { released, assigned: result.assigned };
}

/**
 * Drain the FIFO wait queue: assign freed channels to the oldest WAITING campaigns
 * until the pool is empty or the queue is. Returns how many were assigned. Each
 * newly-assigned campaign fires `onAssigned` (best-effort — a hook failure never
 * blocks draining the rest of the queue).
 */
export async function processQueue(onAssigned?: OnAssigned): Promise<number> {
  let assigned = 0;
  // Hard cap to avoid an unexpected infinite loop.
  for (let i = 0; i < 100_000; i++) {
    const next = await withSystem((tx) =>
      tx.campaignQueue.findFirst({ where: { status: 'WAITING' }, orderBy: { enqueuedAt: 'asc' }, select: { campaignId: true } }),
    );
    if (!next) break;
    const result = await assignForCampaign(next.campaignId);
    if (!result.assigned) break; // pool exhausted — leave the rest queued
    assigned += 1;
    if (onAssigned) {
      try {
        await onAssigned(next.campaignId);
      } catch (err) {
        console.error('[channel-pool] onAssigned hook failed for', next.campaignId, err);
      }
    }
  }
  return assigned;
}

/**
 * IST midnight rollover: release channels held by campaigns no longer in a holding
 * state; for still-active campaigns whose lock is for a previous day, close the
 * prior assignment span and open a new one for today (per-day attribution); then
 * drain the queue into any freed channels.
 */
export async function rolloverChannels(
  today: string = currentBusinessDay(),
  onAssigned?: OnAssigned,
): Promise<{ released: number; renewed: number }> {
  const { released, renewed } = await withSystem(async (tx) => {
    const channels = await tx.channel.findMany({
      where: { status: 'ASSIGNED' },
      select: { id: true, currentCampaignId: true, lockedForDay: true },
    });
    let released = 0;
    let renewed = 0;
    for (const ch of channels) {
      const campaign = ch.currentCampaignId
        ? await tx.campaign.findUnique({ where: { id: ch.currentCampaignId }, select: { status: true, orgId: true } })
        : null;
      const holds = campaign != null && HOLDING_STATUSES.includes(campaign.status);

      if (!holds) {
        // Release THIS channel row (handles multi-channel offers campaigns per-channel).
        await releaseChannelRow(tx, ch.id);
        released += 1;
      } else if (ch.lockedForDay !== today && ch.currentCampaignId && campaign) {
        // New IST day: close yesterday's span, open today's, renew the lock.
        await tx.channelAssignment.updateMany({
          where: { channelRef: ch.id, releasedAt: null },
          data: { releasedAt: new Date() },
        });
        await tx.channelAssignment.create({
          data: { orgId: campaign.orgId, channelRef: ch.id, campaignId: ch.currentCampaignId, forDay: today },
        });
        await tx.channel.update({ where: { id: ch.id }, data: { lockedForDay: today } });
        renewed += 1;
      }
    }
    return { released, renewed };
  });
  await processQueue(onAssigned);
  return { released, renewed };
}

/** Provision channels into the pool (idempotent on `channelId`). Returns created count. */
export async function seedChannels(channelIds: string[]): Promise<number> {
  return withSystem(async (tx) => {
    let created = 0;
    for (const channelId of channelIds) {
      const existing = await tx.channel.findUnique({ where: { channelId }, select: { id: true } });
      if (existing) continue;
      await tx.channel.create({ data: { channelId } });
      created += 1;
    }
    return created;
  });
}
