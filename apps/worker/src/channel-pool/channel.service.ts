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
  channelRef?: string;
}

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
    // Atomically claim one available channel; concurrent claims skip locked rows.
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM channels WHERE status = 'AVAILABLE'
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

/** Release the channel a campaign holds (→ AVAILABLE, close the assignment span). */
async function releaseInTx(tx: TxClient, campaignId: string): Promise<boolean> {
  const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, select: { channelId: true } });
  if (!campaign?.channelId) return false;
  await tx.channel.update({
    where: { id: campaign.channelId },
    data: { status: 'AVAILABLE', currentCampaignId: null, lockedForDay: null, assignedAt: null },
  });
  await tx.channelAssignment.updateMany({
    where: { channelRef: campaign.channelId, campaignId, releasedAt: null },
    data: { releasedAt: new Date() },
  });
  await tx.campaign.update({ where: { id: campaignId }, data: { channelId: null } });
  return true;
}

/** Release a campaign's channel, then hand the freed channel to the next waiter. */
export async function releaseChannelForCampaign(
  campaignId: string,
  onAssigned?: OnAssigned,
): Promise<{ released: boolean }> {
  const released = await withSystem((tx) => releaseInTx(tx, campaignId));
  if (released) await processQueue(onAssigned);
  return { released };
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
    const result = await assignChannel(next.campaignId);
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
        if (ch.currentCampaignId) await releaseInTx(tx, ch.currentCampaignId);
        else await tx.channel.update({ where: { id: ch.id }, data: { status: 'AVAILABLE', lockedForDay: null, assignedAt: null } });
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
