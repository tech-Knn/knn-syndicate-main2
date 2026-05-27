import type { TxClient } from '@knn/db';
import { CAMPAIGN_STATUS, canTransitionCampaign } from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { enqueueChannelAssign } from '../../lib/channel-queue.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { type CampaignWithChildren, campaignInclude } from './campaigns.service.js';

/**
 * Load a campaign for admin review. RLS scopes a COMPANY_ADMIN to their own org
 * (other orgs' campaigns are invisible → 404); a SUPER_ADMIN sees every org. The
 * approve/reject routes are admin-only, so there's no buyer self-scoping here.
 */
async function loadForReview(tx: TxClient, id: string): Promise<CampaignWithChildren> {
  const campaign = await tx.campaign.findUnique({ where: { id }, include: campaignInclude });
  if (!campaign) throw new AppError(404, 'Campaign not found');
  return campaign;
}

/** Admin view of the review queue: campaigns awaiting approval, oldest submission first. */
export async function listPendingApprovals(auth: AuthContext): Promise<CampaignWithChildren[]> {
  return runScoped(auth, (tx) =>
    tx.campaign.findMany({
      where: { status: CAMPAIGN_STATUS.PENDING_APPROVAL },
      orderBy: { submittedAt: 'asc' },
      include: campaignInclude,
    }),
  );
}

/**
 * Approve a pending campaign (admin). Validates the transition against the state
 * machine, records the reviewer, writes an audit entry in the same txn, then
 * notifies the buyer after commit.
 */
export async function approveCampaign(
  auth: AuthContext,
  id: string,
): Promise<CampaignWithChildren> {
  let autoLaunch = false;
  const updated = await runScoped(auth, async (tx) => {
    const campaign = await loadForReview(tx, id);
    if (!canTransitionCampaign(campaign.status, CAMPAIGN_STATUS.APPROVED)) {
      throw new AppError(409, `Cannot approve a campaign in ${campaign.status} state`);
    }
    const org = await tx.organization.findUnique({
      where: { id: campaign.orgId },
      select: { autoLaunch: true },
    });
    autoLaunch = org?.autoLaunch ?? false;
    const result = await tx.campaign.update({
      where: { id },
      data: {
        status: CAMPAIGN_STATUS.APPROVED,
        reviewedById: auth.userId,
        reviewedAt: new Date(),
        rejectionReason: null,
      },
      include: campaignInclude,
    });
    await writeAudit(tx, {
      orgId: campaign.orgId,
      actorId: auth.userId,
      action: 'campaign.approved',
      entityType: 'campaign',
      entityId: id,
    });
    return result;
  });
  await notify({
    orgId: updated.orgId,
    userId: updated.buyerId,
    type: 'campaign.approved',
    title: 'Campaign approved',
    // Auto-launch orgs go live as soon as a channel is assigned; manual-gate orgs
    // wait for an admin to launch (the campaign holds a channel in the meantime).
    body: autoLaunch
      ? `"${updated.name}" was approved and will launch automatically once a channel is assigned.`
      : `"${updated.name}" was approved and is ready to launch once a channel is assigned.`,
  });
  await enqueueChannelAssign(updated.id);
  return updated;
}

/**
 * Reject a pending campaign (admin) with a required reason. The buyer can then
 * revise it back to a draft (REJECTED → DRAFT) and resubmit.
 */
export async function rejectCampaign(
  auth: AuthContext,
  id: string,
  reason: string,
): Promise<CampaignWithChildren> {
  const updated = await runScoped(auth, async (tx) => {
    const campaign = await loadForReview(tx, id);
    if (!canTransitionCampaign(campaign.status, CAMPAIGN_STATUS.REJECTED)) {
      throw new AppError(409, `Cannot reject a campaign in ${campaign.status} state`);
    }
    const result = await tx.campaign.update({
      where: { id },
      data: {
        status: CAMPAIGN_STATUS.REJECTED,
        reviewedById: auth.userId,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
      include: campaignInclude,
    });
    await writeAudit(tx, {
      orgId: campaign.orgId,
      actorId: auth.userId,
      action: 'campaign.rejected',
      entityType: 'campaign',
      entityId: id,
      details: { reason },
    });
    return result;
  });
  await notify({
    orgId: updated.orgId,
    userId: updated.buyerId,
    type: 'campaign.rejected',
    title: 'Campaign rejected',
    body: `"${updated.name}" was rejected: ${reason}`,
  });
  return updated;
}
