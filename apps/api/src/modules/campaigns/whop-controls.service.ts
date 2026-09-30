import type { TxClient } from '@knn/db';
import { CAMPAIGN_STATUS, ROLES } from '@knn/shared';
import { isWhopError } from '@knn/whop';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { writeRedirectConfigs } from '../../lib/kv-sync.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { requireWhopConnection, whopFailure, whopSession } from '../whop/whop.internal.js';
import { syncCampaignRedirectConfigs } from './launch-routing.js';

/**
 * The controls of a LIVE Whop campaign (D32, phase 2): pause / resume, and the two budget edits. Each mirrors its
 * Facebook twin in `launch.service.ts` (same phases, same scope rules, same audit entries) and differs only in what
 * it calls. Order matters for pause and resume: Whop is told FIRST and the local status only follows once Whop
 * agreed, so the two can never disagree in the dangerous direction (we say "paused", Whop keeps spending).
 */

const usd = (cents: number): number => Math.round(cents) / 100;

/** Whop enforces its own budget floor (and says so); we only refuse what cannot be a budget at all. */
function assertBudgetCents(cents: number): void {
  if (!Number.isInteger(cents) || cents < 1) throw new AppError(422, 'Daily budget must be a whole number of cents, at least $0.01.');
}

async function loadScoped<T extends { buyerId: string }>(auth: AuthContext, read: (tx: TxClient) => Promise<T | null>): Promise<T> {
  const row = await runScoped(auth, read);
  if (!row || (auth.role === ROLES.MEDIA_BUYER && row.buyerId !== auth.userId)) throw new AppError(404, 'Campaign not found');
  return row;
}

/** Pause or resume a launched Whop campaign: Whop first, then the local status, then the edge config. */
export async function setWhopCampaignActive(
  auth: AuthContext,
  campaignId: string,
  active: boolean,
  deps: { writeRedirectConfigs: typeof writeRedirectConfigs },
): Promise<{ id: string; status: string }> {
  const target = active ? CAMPAIGN_STATUS.ACTIVE : CAMPAIGN_STATUS.PAUSED;
  const campaign = await loadScoped(auth, (tx) =>
    tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, buyerId: true, orgId: true, status: true, whopCampaignId: true, whopConnectionId: true, whopBizId: true },
    }),
  );
  if (campaign.status === target) return { id: campaignId, status: campaign.status };
  // A campaign Meta rejected can still be running its other ads (and the state machine allows META_REJECTED -> PAUSED), so a
  // pause is allowed from there too; resuming one is not.
  const pausable = campaign.status === CAMPAIGN_STATUS.ACTIVE || campaign.status === CAMPAIGN_STATUS.META_REJECTED;
  if (active ? campaign.status !== CAMPAIGN_STATUS.PAUSED : !pausable) {
    throw new AppError(409, `Only an active or paused campaign can be ${active ? 'resumed' : 'paused'}`);
  }
  if (!campaign.whopCampaignId) throw new AppError(409, 'This campaign is not linked to a Whop campaign yet.');
  // A pause is an emergency stop: it works even when Whop Ads has been switched off for the company since the launch.
  const conn = await requireWhopConnection(campaign, active ? 'resume this campaign' : 'pause this campaign', { ignoreSwitch: !active });

  const { ads } = whopSession(conn);
  try {
    await (active ? ads.unpauseCampaign(campaign.whopCampaignId) : ads.pauseCampaign(campaign.whopCampaignId));
  } catch (err) {
    if (!isWhopError(err)) throw err;
    // Someone may already have done it in Whop itself: if Whop now says the state we wanted, that is success.
    const now = await ads.getCampaign(campaign.whopCampaignId).catch(() => null);
    if (now?.status !== (active ? 'active' : 'paused')) throw await whopFailure(conn, err);
  }

  const updated = await runScoped(auth, async (tx) => {
    const u = await tx.campaign.update({ where: { id: campaignId }, data: { status: target }, select: { id: true, status: true } });
    await writeAudit(tx, {
      orgId: campaign.orgId,
      actorId: auth.userId,
      action: active ? 'campaign.resumed' : 'campaign.paused',
      entityType: 'campaign',
      entityId: campaignId,
    });
    return u;
  });

  // A PAUSED campaign must stop routing residual paid clicks to the money page (see the Facebook twin); resume re-enables.
  await syncCampaignRedirectConfigs(campaignId, deps).catch((e) =>
    console.warn(`[setWhopCampaignActive] edge KV resync failed for ${campaignId}: ${e instanceof Error ? e.message : String(e)}`),
  );
  return updated;
}

/**
 * Live budget edit of a Whop campaign: the campaign's own budget under CBO, the single ad group's under ABO.
 * Multi-ad-group ABO is refused here (use the per-ad-set edit), exactly as on Facebook: we never silently
 * redistribute money. No channel release and no edge-config write: a budget does not change routing.
 */
export async function updateWhopCampaignBudget(auth: AuthContext, campaignId: string, input: { dailyBudgetCents: number }): Promise<{ id: string; dailyBudgetCents: number }> {
  const cents = input.dailyBudgetCents;
  assertBudgetCents(cents);

  const campaign = await loadScoped(auth, (tx) =>
    tx.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true, buyerId: true, orgId: true, status: true, budgetMode: true, dailyBudgetCents: true,
        whopCampaignId: true, whopConnectionId: true, whopBizId: true,
        adSets: { select: { id: true, whopAdGroupId: true, dailyBudgetCents: true } },
      },
    }),
  );
  if (campaign.status !== CAMPAIGN_STATUS.ACTIVE && campaign.status !== CAMPAIGN_STATUS.PAUSED) {
    throw new AppError(409, 'Only a live (active or paused) campaign’s budget can be edited here. Reopen a draft to change its budget before launch.');
  }
  if (!campaign.whopCampaignId) throw new AppError(409, 'This campaign is not linked to a Whop campaign yet.');

  let target: { kind: 'campaign'; whopId: string } | { kind: 'adgroup'; whopId: string; adSetId: string };
  let oldCents: number | null;
  if (campaign.budgetMode === 'CAMPAIGN') {
    target = { kind: 'campaign', whopId: campaign.whopCampaignId };
    oldCents = campaign.dailyBudgetCents;
  } else {
    const launched = campaign.adSets.filter((s) => s.whopAdGroupId);
    if (launched.length !== 1) {
      throw new AppError(
        409,
        launched.length === 0
          ? 'This campaign has no launched ad group to budget.'
          : 'This campaign uses per-ad-set budgets across multiple ad sets. Edit each ad set’s budget individually (open the campaign to edit them).',
      );
    }
    target = { kind: 'adgroup', whopId: launched[0]!.whopAdGroupId!, adSetId: launched[0]!.id };
    oldCents = launched[0]!.dailyBudgetCents;
  }
  const conn = await requireWhopConnection(campaign, 'change its budget');
  if (oldCents === cents) return { id: campaignId, dailyBudgetCents: cents };

  try {
    const { ads } = whopSession(conn);
    // Only the amount: Whop allows changing a campaign's budget TYPE only before launch, and may refuse a request that names it.
    if (target.kind === 'campaign') await ads.updateCampaign(target.whopId, { budget_amount: usd(cents) });
    else await ads.updateAdGroup(target.whopId, { budget_amount: usd(cents) });
  } catch (err) {
    if (isWhopError(err)) throw await whopFailure(conn, err);
    throw err;
  }

  await runScoped(auth, async (tx) => {
    if (target.kind === 'campaign') await tx.campaign.update({ where: { id: campaignId }, data: { dailyBudgetCents: cents } });
    else await tx.adSet.update({ where: { id: target.adSetId }, data: { dailyBudgetCents: cents } });
    await writeAudit(tx, {
      orgId: campaign.orgId,
      actorId: auth.userId,
      action: 'campaign.budget_updated',
      entityType: 'campaign',
      entityId: campaignId,
      details: { provider: 'WHOP', fromCents: oldCents, toCents: cents },
    });
  });
  return { id: campaignId, dailyBudgetCents: cents };
}

/** Live per-ad-set budget edit of a Whop campaign (one ad group's budget under ABO). */
export async function updateWhopAdSetBudget(
  auth: AuthContext,
  campaignId: string,
  adSetId: string,
  input: { dailyBudgetCents: number },
): Promise<{ id: string; adSetId: string; dailyBudgetCents: number }> {
  const cents = input.dailyBudgetCents;
  assertBudgetCents(cents);

  const campaign = await loadScoped(auth, (tx) =>
    tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, buyerId: true, orgId: true, status: true, budgetMode: true, whopConnectionId: true, whopBizId: true },
    }),
  );
  if (campaign.status !== CAMPAIGN_STATUS.ACTIVE && campaign.status !== CAMPAIGN_STATUS.PAUSED) {
    throw new AppError(409, 'Only a live (active or paused) campaign’s budget can be edited here.');
  }
  if (campaign.budgetMode !== 'AD_SET') throw new AppError(409, 'This campaign uses a single campaign budget (CBO). Edit the campaign budget instead.');
  // The ad set must belong to THIS campaign (prevents cross-campaign id tampering) and be launched.
  const set = await runScoped(auth, (tx) => tx.adSet.findFirst({ where: { id: adSetId, campaignId }, select: { id: true, whopAdGroupId: true, dailyBudgetCents: true } }));
  if (!set) throw new AppError(404, 'Ad set not found');
  if (!set.whopAdGroupId) throw new AppError(409, 'This ad set is not linked to Whop yet.');
  const conn = await requireWhopConnection(campaign, 'change its budget');
  if (set.dailyBudgetCents === cents) return { id: campaignId, adSetId, dailyBudgetCents: cents };

  try {
    await whopSession(conn).ads.updateAdGroup(set.whopAdGroupId, { budget_amount: usd(cents) });
  } catch (err) {
    if (isWhopError(err)) throw await whopFailure(conn, err);
    throw err;
  }

  await runScoped(auth, async (tx) => {
    await tx.adSet.update({ where: { id: adSetId }, data: { dailyBudgetCents: cents } });
    await writeAudit(tx, {
      orgId: campaign.orgId,
      actorId: auth.userId,
      action: 'campaign.budget_updated',
      entityType: 'campaign',
      entityId: campaignId,
      details: { provider: 'WHOP', adSetId, fromCents: set.dailyBudgetCents, toCents: cents },
    });
  });
  return { id: campaignId, adSetId, dailyBudgetCents: cents };
}
