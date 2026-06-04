import { withSystem } from '@knn/db';
import { type CampaignDeliveryDTO, fetchCampaignDelivery } from '@knn/fb';
import { CAMPAIGN_STATUS, type CampaignStatus, canTransitionCampaign } from '@knn/shared';
import { releaseChannelForCampaign } from '../channel-pool/channel.service.js';
import { resolveCampaignReadAuth } from '../lib/fb-read-auth.js';
import { sendNotification } from '../lib/notify.js';
import { resyncOffersToKv } from '../launch-trigger.js';

/**
 * Campaign reconciliation (D14 + live status sync). Facebook has no reliable webhook for
 * "ad disapproved" OR "campaign paused/resumed", so a cron polls each launched campaign's
 * live delivery (`effective_status` of the campaign node + its ads, one Graph call) and
 * reconciles our DB against it:
 *
 *   1. any ad DISAPPROVED → META_REJECTED — release the channel, re-publish the edge KV,
 *      notify the buyer (the original meta-rejection behaviour; takes precedence).
 *   2. campaign paused/resumed directly in Ads Manager → mirror ACTIVE↔PAUSED into
 *      `Campaign.status` so Analytics reflects reality (the bug this fixes: a buyer who
 *      pauses in Facebook saw our status stay ACTIVE forever). The channel is KEPT on
 *      pause (reversible, matches our own pause path); only rejection/archival releases it.
 *
 * Only ACTIVE↔PAUSED are reconciled — archival/deletion and transient review states
 * (IN_PROCESS, PENDING_REVIEW, WITH_ISSUES, …) are deliberately left alone. Every flip is
 * guarded by `canTransitionCampaign` and re-syncs the edge KV so the redirect `active`
 * flag follows `status`. Deps are injectable for tests (no real FB / token decrypt).
 */
interface CampaignRow {
  id: string;
  orgId: string;
  buyerId: string;
  name: string;
  fbCampaignId: string | null;
  adAccountId: string | null;
}
interface Notification {
  orgId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
}

export interface ReconcileDeps {
  /** Fetch the campaign's live delivery (its effective_status + every ad's). */
  fetchDelivery?: (c: CampaignRow) => Promise<CampaignDeliveryDTO>;
  releaseChannel?: (campaignId: string) => Promise<unknown>;
  /** Re-publish the edge KV so the redirect `active` flag follows the new status (B1). */
  resync?: (campaignId: string) => Promise<unknown>;
  notify?: (n: Notification) => void;
}

const DISAPPROVED = 'DISAPPROVED';

/** Map a Facebook campaign `effective_status` to the `Campaign.status` we should reconcile
 *  to, or `null` to leave it untouched. Only the reversible ACTIVE↔PAUSED pair is mirrored;
 *  archival/deletion and transient review states are intentionally not auto-applied. */
function fbStatusToTarget(fbStatus: string): CampaignStatus | null {
  switch (fbStatus) {
    case 'ACTIVE':
      return CAMPAIGN_STATUS.ACTIVE;
    case 'PAUSED':
    case 'CAMPAIGN_PAUSED':
      return CAMPAIGN_STATUS.PAUSED;
    default:
      return null;
  }
}

/** Fetch the campaign's live delivery using a token resolved by the STABLE Meta fbAccountId against
 *  the buyer's CURRENT healthy connection (survives reconnects/app-switches — see resolveCampaignReadAuth). */
async function defaultFetchDelivery(c: CampaignRow): Promise<CampaignDeliveryDTO> {
  if (!c.fbCampaignId) return { effectiveStatus: '', adSets: [], ads: [] };
  const auth = await resolveCampaignReadAuth(c.adAccountId);
  if (!auth) return { effectiveStatus: '', adSets: [], ads: [] };
  return fetchCampaignDelivery(auth.fbAccountId, auth.token, c.fbCampaignId, auth.appKind);
}

const defaultNotify = (n: Notification): void => sendNotification(n);

/** Mirror each ad set's / ad's live Facebook effective_status into the DB (display-only — the
 *  campaign status governs the redirect). Only rows whose status actually CHANGED are written,
 *  so the 30-min poll doesn't churn `updated_at` on every entity each tick. Matches FB entities
 *  to our rows by fbAdSetId / fbAdId, scoped to the campaign. Returns the number of rows updated. */
async function syncSubEntityStatuses(campaignId: string, delivery: CampaignDeliveryDTO): Promise<number> {
  const setStatus = new Map(delivery.adSets.map((s) => [s.fbAdSetId, s.effectiveStatus]));
  const adStatus = new Map(delivery.ads.map((a) => [a.fbAdId, a.effectiveStatus]));
  if (setStatus.size === 0 && adStatus.size === 0) return 0;

  return withSystem(async (tx) => {
    const sets = await tx.adSet.findMany({
      where: { campaignId },
      select: {
        id: true,
        fbAdSetId: true,
        effectiveStatus: true,
        ads: { select: { id: true, fbAdId: true, effectiveStatus: true } },
      },
    });
    const updates: Promise<unknown>[] = [];
    for (const s of sets) {
      if (s.fbAdSetId) {
        const next = setStatus.get(s.fbAdSetId);
        // `next &&` skips empty/undefined so we never overwrite a real status with a blank.
        if (next && next !== (s.effectiveStatus ?? '')) {
          updates.push(tx.adSet.update({ where: { id: s.id }, data: { effectiveStatus: next } }));
        }
      }
      for (const a of s.ads) {
        if (a.fbAdId) {
          const next = adStatus.get(a.fbAdId);
          if (next && next !== (a.effectiveStatus ?? '')) {
            updates.push(tx.ad.update({ where: { id: a.id }, data: { effectiveStatus: next } }));
          }
        }
      }
    }
    await Promise.all(updates);
    return updates.length;
  });
}

export async function reconcileCampaigns(
  deps: ReconcileDeps = {},
): Promise<{ checked: number; rejected: number; statusSynced: number; subSynced: number }> {
  const fetchDelivery = deps.fetchDelivery ?? defaultFetchDelivery;
  const releaseChannel = deps.releaseChannel ?? releaseChannelForCampaign;
  const resync = deps.resync ?? resyncOffersToKv;
  const notify = deps.notify ?? defaultNotify;

  // Both ACTIVE and PAUSED launched campaigns are in scope: ACTIVE ones can be rejected or
  // paused-in-FB; PAUSED ones can be resumed-in-FB (or rejected). Pre-launch/terminal states
  // have no live FB delivery to reconcile against. Runs on the 30-min cron sweep (no manual
  // trigger — that would breach the per-account rate limits).
  const campaigns = (await withSystem((tx) =>
    tx.campaign.findMany({
      where: {
        status: { in: [CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED] },
        fbCampaignId: { not: null },
      },
      select: { id: true, orgId: true, buyerId: true, name: true, fbCampaignId: true, adAccountId: true },
    }),
  )) as CampaignRow[];

  let rejected = 0;
  let statusSynced = 0;
  let subSynced = 0;
  for (const c of campaigns) {
    let delivery: CampaignDeliveryDTO;
    try {
      delivery = await fetchDelivery(c);
    } catch (err) {
      console.error(`[reconcile] delivery fetch failed for ${c.id}:`, (err as Error).message);
      continue;
    }

    // 0) Mirror per-ad-set / per-ad effective_status (display-only) for EVERY in-scope campaign,
    //    regardless of the campaign-level outcome below — so a campaign about to be META_REJECTED
    //    still records which ad was DISAPPROVED.
    try {
      subSynced += await syncSubEntityStatuses(c.id, delivery);
    } catch (err) {
      console.warn(`[reconcile] sub-entity status sync failed for ${c.id}:`, err instanceof Error ? err.message : String(err));
    }

    // 1) Disapproval takes precedence — it's the most actionable state and the only one that
    //    must release the channel. A campaign can be PAUSED in FB yet still hold a disapproved
    //    ad; reject regardless of the campaign-level status.
    if (delivery.ads.some((s) => s.effectiveStatus === DISAPPROVED)) {
      let didReject = false;
      await withSystem(async (tx) => {
        const fresh = await tx.campaign.findUnique({ where: { id: c.id }, select: { status: true } });
        if (fresh && canTransitionCampaign(fresh.status, CAMPAIGN_STATUS.META_REJECTED)) {
          await tx.campaign.update({ where: { id: c.id }, data: { status: CAMPAIGN_STATUS.META_REJECTED } });
          didReject = true;
        }
      });
      if (didReject) {
        await releaseChannel(c.id);
        // B1: META_REJECTED + channel released → re-publish the edge KV so the redirect goes
        // active:false and stops emitting the (now-reassignable) channel; otherwise residual
        // paid clicks keep monetizing a disapproved page and credit whoever next holds it.
        await resync(c.id).catch((err) =>
          console.warn(`[reconcile] edge KV resync failed for ${c.id}:`, err instanceof Error ? err.message : String(err)),
        );
        notify({
          orgId: c.orgId,
          userId: c.buyerId,
          type: 'campaign.meta_rejected',
          title: 'Campaign rejected by Facebook',
          body: `"${c.name}" was disapproved by Facebook; it's been stopped and its channel released.`,
        });
        rejected += 1;
      }
      continue;
    }

    // 2) Mirror a pause/resume the buyer did directly in Ads Manager into Campaign.status.
    const target = fbStatusToTarget(delivery.effectiveStatus);
    if (!target) continue; // archived/deleted/transient → leave it alone
    let didSync = false;
    await withSystem(async (tx) => {
      const fresh = await tx.campaign.findUnique({ where: { id: c.id }, select: { status: true } });
      if (fresh && fresh.status !== target && canTransitionCampaign(fresh.status, target)) {
        await tx.campaign.update({ where: { id: c.id }, data: { status: target } });
        didSync = true;
      }
    });
    if (didSync) {
      // The redirect `active` flag is derived from campaign.status (ACTIVE → emits the channel;
      // PAUSED → active:false). Re-publish so the edge follows. Pausing KEEPS the channel.
      await resync(c.id).catch((err) =>
        console.warn(`[reconcile] edge KV resync failed for ${c.id}:`, err instanceof Error ? err.message : String(err)),
      );
      const resumed = target === CAMPAIGN_STATUS.ACTIVE;
      notify({
        orgId: c.orgId,
        userId: c.buyerId,
        type: 'campaign.status_synced',
        title: resumed ? 'Campaign resumed' : 'Campaign paused',
        body: `"${c.name}" was ${resumed ? 'resumed' : 'paused'} in Facebook; the change is now reflected here.`,
      });
      statusSynced += 1;
    }
  }
  return { checked: campaigns.length, rejected, statusSynced, subSynced };
}
