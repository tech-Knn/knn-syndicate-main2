import { type TxClient, withSystem } from '@knn/db';
import { isWhopError } from '@knn/whop';
import { writeAudit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { type WhopCampaignRef, resolveCampaignConnection, whopSession } from '../whop/whop.internal.js';

/**
 * Taking a Whop campaign back to a DRAFT (D33, phase 2).
 *
 * A draft must never point at Whop objects: `updateCampaign` replaces a draft's ad sets and ads wholesale, so ids
 * kept on a draft would be lost with the rows and the next launch would create a second set beside the old
 * one. A half-finished launch is the only way a pre-launch state (the ones a campaign can be reopened from) holds
 * Whop ids, so reopening clears them and then deletes the Whop campaign, which cascades to its ad groups and ads.
 *
 * The order is deliberate: the ids are cleared in the same transaction as the reopen (`clearWhopIds`), so our
 * rows are consistent the moment it commits, and the Whop delete runs after (`discardWhopCampaign`). If that
 * delete fails the worst case is an orphaned Whop campaign, which is reported to the buyer and the audit trail
 * instead of hidden, rather than a draft that still references it.
 */

/**
 * Forget every Whop id on a campaign's rows. Call inside the transaction that reopens / relaunches it.
 * `keepFiles` leaves the uploaded creatives' ids alone (a relaunch reuses them; they do not go stale).
 * It also moves the campaign to its NEXT key epoch: Whop replays a repeated idempotency key for 24 h, so the tree
 * that replaces the discarded one must not reuse its keys (see `whopKeys`).
 */
export async function clearWhopIds(tx: TxClient, campaignId: string, opts: { keepFiles?: boolean } = {}): Promise<void> {
  await tx.ad.updateMany({ where: { adSet: { campaignId } }, data: opts.keepFiles ? { whopAdId: null } : { whopAdId: null, whopFileId: null } });
  await tx.adSet.updateMany({ where: { campaignId }, data: { whopAdGroupId: null } });
  await tx.campaign.update({ where: { id: campaignId }, data: { whopCampaignId: null, whopDeliveryStatus: null, whopIssues: [], whopKeyEpoch: { increment: 1 } } });
}

export interface WhopLeftover extends WhopCampaignRef {
  id: string;
  name: string;
  whopCampaignId: string;
}

/** The leftover to discard, if this campaign has one. */
export function whopLeftover(c: {
  id: string;
  name: string;
  orgId: string;
  buyerId: string;
  adProvider: string;
  whopCampaignId: string | null;
  whopConnectionId: string | null;
  whopBizId: string | null;
}): WhopLeftover | null {
  if (c.adProvider !== 'WHOP' || !c.whopCampaignId) return null;
  return { id: c.id, name: c.name, orgId: c.orgId, buyerId: c.buyerId, whopCampaignId: c.whopCampaignId, whopConnectionId: c.whopConnectionId, whopBizId: c.whopBizId };
}

/**
 * Delete a campaign's Whop objects. Never throws (the caller's own change has already committed): a failure
 * is audited and the buyer is told which Whop campaign to delete by hand. Already gone (404) counts as deleted.
 */
export async function discardWhopCampaign(leftover: WhopLeftover, actorId: string | null): Promise<'deleted' | 'orphaned'> {
  const orphan = async (why: string): Promise<'orphaned'> => {
    await withSystem((tx) =>
      writeAudit(tx, {
        orgId: leftover.orgId,
        actorId,
        action: 'whop.campaign_orphaned',
        entityType: 'campaign',
        entityId: leftover.id,
        details: { whopCampaignId: leftover.whopCampaignId, reason: why },
      }),
    ).catch(() => undefined);
    await notify({
      orgId: leftover.orgId,
      userId: leftover.buyerId,
      type: 'whop_campaign_orphaned',
      title: 'A Whop campaign needs deleting by hand',
      body: `"${leftover.name}" went back to a draft, but its Whop campaign ${leftover.whopCampaignId} could not be deleted (${why}). Delete it in Whop so it cannot run.`,
    });
    return 'orphaned';
  };

  try {
    const conn = await resolveCampaignConnection(leftover);
    if (!conn) return orphan('its Whop business is no longer connected');
    await whopSession(conn).ads.deleteCampaign(leftover.whopCampaignId);
  } catch (err) {
    if (isWhopError(err) && err.kind === 'not_found') return 'deleted';
    return orphan(isWhopError(err) ? err.message : err instanceof Error ? err.message : 'unknown error');
  }
  await withSystem((tx) =>
    writeAudit(tx, { orgId: leftover.orgId, actorId, action: 'whop.campaign_discarded', entityType: 'campaign', entityId: leftover.id, details: { whopCampaignId: leftover.whopCampaignId } }),
  ).catch(() => undefined);
  return 'deleted';
}
