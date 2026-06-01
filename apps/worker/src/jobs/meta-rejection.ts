import { withSystem } from '@knn/db';
import { type AdStatusDTO, decryptToken, fetchCampaignAdStatuses } from '@knn/fb';
import { CAMPAIGN_STATUS, canTransitionCampaign } from '@knn/shared';
import { releaseChannelForCampaign } from '../channel-pool/channel.service.js';
import { sendNotification } from '../lib/notify.js';
import { resyncOffersToKv } from '../launch-trigger.js';

/**
 * Meta-rejection polling (D14). Facebook has no reliable "ad disapproved" webhook,
 * so a cron polls `effective_status` for ACTIVE campaigns' ads; a DISAPPROVED ad
 * flips the campaign to META_REJECTED, releases its channel back to the pool, and
 * notifies the buyer. Deps are injectable for tests (no real FB / token decrypt).
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

export interface MetaRejectionDeps {
  fetchStatuses?: (c: CampaignRow) => Promise<AdStatusDTO[]>;
  releaseChannel?: (campaignId: string) => Promise<unknown>;
  /** Re-publish the edge KV so a META_REJECTED campaign stops emitting its (released) channel (B1). */
  resync?: (campaignId: string) => Promise<unknown>;
  notify?: (n: Notification) => void;
}

const DISAPPROVED = 'DISAPPROVED';

/** Resolve the ad-account's connection token, then fetch the campaign's ad statuses. */
async function defaultFetchStatuses(c: CampaignRow): Promise<AdStatusDTO[]> {
  if (!c.fbCampaignId || !c.adAccountId) return [];
  // Use the token of the connection that owns the campaign's ad account (a buyer
  // may have several connected profiles), not "the buyer's (only) connection".
  const acc = await withSystem((tx) =>
    tx.fbAdAccount.findUnique({
      where: { id: c.adAccountId! },
      select: { fbAccountId: true, connection: { select: { accessTokenEnc: true, status: true } } },
    }),
  );
  if (!acc || acc.connection.status === 'CONNECTION_BROKEN') return [];
  return fetchCampaignAdStatuses(acc.fbAccountId, decryptToken(acc.connection.accessTokenEnc), c.fbCampaignId);
}

const defaultNotify = (n: Notification): void => sendNotification(n);

export async function checkMetaRejections(
  deps: MetaRejectionDeps = {},
): Promise<{ checked: number; rejected: number }> {
  const fetchStatuses = deps.fetchStatuses ?? defaultFetchStatuses;
  const releaseChannel = deps.releaseChannel ?? releaseChannelForCampaign;
  const resync = deps.resync ?? resyncOffersToKv;
  const notify = deps.notify ?? defaultNotify;

  const campaigns = (await withSystem((tx) =>
    tx.campaign.findMany({
      where: { status: CAMPAIGN_STATUS.ACTIVE, fbCampaignId: { not: null } },
      select: { id: true, orgId: true, buyerId: true, name: true, fbCampaignId: true, adAccountId: true },
    }),
  )) as CampaignRow[];

  let rejected = 0;
  for (const c of campaigns) {
    let statuses: AdStatusDTO[];
    try {
      statuses = await fetchStatuses(c);
    } catch (err) {
      console.error(`[meta-rejection] status fetch failed for ${c.id}:`, (err as Error).message);
      continue;
    }
    if (!statuses.some((s) => s.effectiveStatus === DISAPPROVED)) continue;

    await withSystem(async (tx) => {
      const fresh = await tx.campaign.findUnique({ where: { id: c.id }, select: { status: true } });
      if (fresh && canTransitionCampaign(fresh.status, CAMPAIGN_STATUS.META_REJECTED)) {
        await tx.campaign.update({ where: { id: c.id }, data: { status: CAMPAIGN_STATUS.META_REJECTED } });
      }
    });
    await releaseChannel(c.id);
    // B1: the campaign is now META_REJECTED and its channel released → re-publish the edge KV so the
    // redirect goes active:false and stops emitting the (now-reassignable) channel; otherwise residual
    // paid clicks keep monetizing a disapproved page and credit whoever next holds that channel.
    await resync(c.id).catch((err) =>
      console.warn(`[meta-rejection] edge KV resync failed for ${c.id}:`, err instanceof Error ? err.message : String(err)),
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
  return { checked: campaigns.length, rejected };
}
