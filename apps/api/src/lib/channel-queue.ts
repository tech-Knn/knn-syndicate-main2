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
