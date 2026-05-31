import { env } from '@knn/config';
import { withSystem } from '@knn/db';
import { QUEUES, getQueue } from '@knn/queue';

export interface FbLaunchJob {
  campaignId: string;
}

export interface AutoLaunchDeps {
  enqueueLaunch: (campaignId: string) => Promise<void>;
}

/**
 * De-dupe key for a campaign's auto-launch job. BullMQ forbids ':' in a custom job id
 * (throws "Custom Id cannot contain :"), so the prefix is '-'-joined. Keep it colon-free
 * (guarded by a test) — a ':' here silently breaks the whole approve→assign→launch chain.
 */
export const launchJobId = (campaignId: string): string => `launch-${campaignId}`;

/** Enqueue an FB_LAUNCH job (deduped). The launch runs on the API side. */
async function defaultEnqueueLaunch(campaignId: string): Promise<void> {
  await getQueue(QUEUES.FB_LAUNCH).add(
    'launch',
    { campaignId } satisfies FbLaunchJob,
    {
      // De-dupe concurrent triggers for the same campaign (jobId). The launch is only
      // idempotent on FULL success (fbCampaignId set) — a non-rate-limit failure can
      // leave FB objects half-created, so we do NOT auto-retry (attempts:1) to avoid a
      // duplicate FB campaign. A rate-limit is NOT a job failure: the API parks the
      // campaign in BATCHED (a 200) for the stats/meta crons to re-drive. A genuinely
      // failed job lands in Bull-Board for an admin to retry via the manual launch.
      jobId: launchJobId(campaignId),
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200,
    },
  );
}

const defaultAutoLaunchDeps: AutoLaunchDeps = { enqueueLaunch: defaultEnqueueLaunch };

/**
 * Auto-launch trigger (Phase 8, org toggle). Called right after a campaign acquires
 * a channel. If the owning org has `autoLaunch` on and the campaign holds its channel(s)
 * but hasn't been pushed to Facebook yet, enqueue an `FB_LAUNCH` job. The gate is
 * cheap and idempotent — re-runs (queue drain, rollover, re-approval) are no-ops once
 * `fbCampaignId` is set or auto-launch is off. The actual launch runs on the API
 * process (which owns the FB client + creative files on disk), reached over HTTP by
 * the `FB_LAUNCH` worker.
 *
 * "Holds a channel" depends on the campaign model (mirrors `launchCampaign`'s gate):
 *  - **Offers campaign** (the standard model — submit requires ≥1 PAID offer): EVERY
 *    PAID offer must hold a `channelRef`. The channel lives on the offer, NOT on
 *    `campaign.channelId`, so checking only `channelId` would wrongly bail and the
 *    campaign would sit in PROCESSING forever even with auto-launch on.
 *  - **Legacy single-channel campaign**: `campaign.channelId` is set.
 */
export async function triggerAutoLaunch(
  campaignId: string,
  deps: AutoLaunchDeps = defaultAutoLaunchDeps,
): Promise<{ enqueued: boolean }> {
  const campaign = await withSystem((tx) =>
    tx.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        channelId: true,
        fbCampaignId: true,
        organization: { select: { autoLaunch: true } },
        offers: { where: { kind: 'PAID' }, select: { channelRef: true } },
      },
    }),
  );
  if (!campaign) return { enqueued: false };
  if (!campaign.organization.autoLaunch) return { enqueued: false };
  if (campaign.fbCampaignId) return { enqueued: false }; // already on Facebook

  const paidOffers = campaign.offers;
  const hasChannels =
    paidOffers.length > 0
      ? paidOffers.every((o) => o.channelRef != null) // offers campaign: all PAID offers assigned
      : campaign.channelId != null; // legacy single-channel
  if (!hasChannels) return { enqueued: false };

  await deps.enqueueLaunch(campaignId);
  return { enqueued: true };
}

export interface RunFbLaunchDeps {
  fetch: typeof fetch;
  token: string;
  baseUrl: string;
}
const defaultRunFbLaunchDeps: RunFbLaunchDeps = {
  fetch,
  token: env.INTERNAL_API_TOKEN,
  baseUrl: env.INTERNAL_API_URL,
};

/**
 * Process one `FB_LAUNCH` job: POST the API's token-guarded internal launch endpoint
 * (the launch must run on the API process). A non-2xx response throws so BullMQ
 * retries with backoff; an FB rate-limit lands the campaign in BATCHED on the API
 * side (still a 200 here) and the meta/stats crons drive it forward.
 */
export async function runFbLaunch(
  job: FbLaunchJob,
  deps: RunFbLaunchDeps = defaultRunFbLaunchDeps,
): Promise<{ status: string }> {
  if (!deps.token) {
    throw new Error('INTERNAL_API_TOKEN is not configured — cannot trigger auto-launch');
  }
  const url = `${deps.baseUrl}/api/internal/launch/${job.campaignId}`;
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { 'x-internal-token': deps.token },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`internal launch failed (${res.status}) for ${job.campaignId}: ${text}`);
  }
  const body = (await res.json().catch(() => ({}))) as { status?: string };
  return { status: body.status ?? 'unknown' };
}

/**
 * Re-sync a campaign's edge KV redirect configs from its current offers — NO Facebook
 * (OQ#9 live offer rebalance). POSTs the API's token-guarded internal resync endpoint
 * after the worker has assigned/released channels for an add/remove.
 */
export async function resyncOffersToKv(
  campaignId: string,
  deps: RunFbLaunchDeps = defaultRunFbLaunchDeps,
): Promise<void> {
  if (!deps.token) throw new Error('INTERNAL_API_TOKEN is not configured — cannot re-sync offers');
  const res = await deps.fetch(`${deps.baseUrl}/api/internal/resync-offers/${campaignId}`, {
    method: 'POST',
    headers: { 'x-internal-token': deps.token },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`internal offer resync failed (${res.status}) for ${campaignId}: ${text}`);
  }
}
