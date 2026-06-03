import { withSystem } from '@knn/db';
import { type CampaignDeliveryDTO, decryptToken, fetchCampaignDelivery } from '@knn/fb';
import { CAMPAIGN_STATUS, type CampaignStatus, canTransitionCampaign } from '@knn/shared';
import { releaseChannelForCampaign } from '../channel-pool/channel.service.js';
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

/** Resolve the ad-account's connection token, then fetch the campaign's live delivery. */
async function defaultFetchDelivery(c: CampaignRow): Promise<CampaignDeliveryDTO> {
  if (!c.fbCampaignId || !c.adAccountId) return { effectiveStatus: '', ads: [] };
  // Use the token of the connection that owns the campaign's ad account (a buyer
  // may have several connected profiles), not "the buyer's (only) connection".
  const acc = await withSystem((tx) =>
    tx.fbAdAccount.findUnique({
      where: { id: c.adAccountId! },
      select: { fbAccountId: true, connection: { select: { accessTokenEnc: true, status: true } } },
    }),
  );
  if (!acc || acc.connection.status === 'CONNECTION_BROKEN') return { effectiveStatus: '', ads: [] };
  return fetchCampaignDelivery(acc.fbAccountId, decryptToken(acc.connection.accessTokenEnc), c.fbCampaignId);
}

const defaultNotify = (n: Notification): void => sendNotification(n);

export async function reconcileCampaigns(
  deps: ReconcileDeps = {},
): Promise<{ checked: number; rejected: number; statusSynced: number }> {
  const fetchDelivery = deps.fetchDelivery ?? defaultFetchDelivery;
  const releaseChannel = deps.releaseChannel ?? releaseChannelForCampaign;
  const resync = deps.resync ?? resyncOffersToKv;
  const notify = deps.notify ?? defaultNotify;

  // Both ACTIVE and PAUSED launched campaigns are in scope: ACTIVE ones can be rejected or
  // paused-in-FB; PAUSED ones can be resumed-in-FB (or rejected). Pre-launch/terminal states
  // have no live FB delivery to reconcile against.
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
  for (const c of campaigns) {
    let delivery: CampaignDeliveryDTO;
    try {
      delivery = await fetchDelivery(c);
    } catch (err) {
      console.error(`[reconcile] delivery fetch failed for ${c.id}:`, (err as Error).message);
      continue;
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
  return { checked: campaigns.length, rejected, statusSynced };
}
