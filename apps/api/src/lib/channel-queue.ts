import { QUEUES, getQueue } from '@knn/queue';

/**
 * Ask the worker to assign a channel to a freshly-approved campaign (D7/D11). The
 * worker is the single writer; it grabs a free channel (FOR UPDATE SKIP LOCKED)
 * → PROCESSING, or enqueues the campaign (QUEUED_NO_CHANNEL) when the pool is full.
 * Best-effort: a failure here doesn't fail the approval (the rollover/queue cron
 * also re-drives assignment).
 */
export async function enqueueChannelAssign(campaignId: string): Promise<void> {
  try {
    await getQueue(QUEUES.CHANNEL_MAINTENANCE).add(
      'assign',
      { action: 'assign', campaignId },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
  } catch (err) {
    console.error('[channel-queue] failed to enqueue assign for', campaignId, err);
  }
}

/**
 * Ask the worker to REBALANCE a live campaign's offers: assign channels to newly-added
 * offers + release channels of removed offers (single-writer / SKIP LOCKED), then re-sync
 * the edge KV redirect configs — all WITHOUT touching Facebook (OQ#9 live offer edit).
 * Not best-effort: the caller surfaces a failure so the UI can prompt a retry.
 */
export async function enqueueOfferRebalance(campaignId: string): Promise<void> {
  await getQueue(QUEUES.CHANNEL_MAINTENANCE).add(
    'rebalance',
    { action: 'rebalance', campaignId },
    { removeOnComplete: 100, removeOnFail: 100 },
  );
}

/**
 * A campaign was just RESUMED: make sure it holds a channel for every PAID offer. The midnight rollover releases the
 * channels of paused campaigns, so one paused across midnight comes back without one and would run unattributed. The
 * worker (single writer) assigns what is missing, never queues or re-statuses the live campaign, and re-publishes the
 * edge config. Best-effort: the resume already succeeded, and the worker's 30-minute status job gives a channel to any
 * ACTIVE campaign still missing one, so a lost request is repaired by itself.
 */
export async function requestChannelsForResumedCampaign(campaignId: string): Promise<void> {
  try {
    await enqueueOfferRebalance(campaignId);
  } catch (err) {
    console.error('[channel-queue] failed to enqueue channel restore for resumed campaign', campaignId, err);
  }
}
