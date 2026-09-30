import { env } from '@knn/config';
import { WhopConnectionStatus, withSystem } from '@knn/db';
import {
  CAMPAIGN_STATUS,
  type CampaignStatus,
  canTransitionCampaign,
  whopAdEffectiveStatus,
  whopAdGroupEffectiveStatus,
  whopBillingFailed,
  whopSyncTarget,
} from '@knn/shared';
import { type WhopAd, type WhopAdCampaign, type WhopAdsApi, type WhopIssue, isWhopError } from '@knn/whop';
import { releaseChannelForCampaign } from '../channel-pool/channel.service.js';
import { resyncOffersToKv } from '../launch-trigger.js';
import { sendNotification } from '../lib/notify.js';
import {
  PassBudget,
  TRANSPORT_FAILURES_BEFORE_STOP,
  type WhopConnectionRow,
  handleWhopReadFailure,
  nextTransportFailures,
  resolveWhopConnection,
  rotate,
  whopAdsForConnection,
} from '../lib/whop-auth.js';

/**
 * Whop campaign reconciliation (D33, phase 2): the Whop twin of `meta-rejection.ts`. Whop runs the Meta ads, and
 * Meta's ad review happens AFTER launch, so neither a rejection nor a pause/resume done in Whop's own dashboard
 * reaches us by itself. A cron reads each business's campaigns (one bulk call per 100, not one per campaign) and
 * their ads, and reconciles our rows against what Whop reports:
 *
 *   1. EVERY ad rejected (Whop's `all_ads_rejected`, or all of the campaign's ads rejected / in appeal) -> META_REJECTED:
 *      stop it at Whop too (best effort: our redirect no longer sends it traffic, so a still-delivering ad would only
 *      burn money), stop routing to it, notify the buyer. Takes precedence. SOME ads rejected does NOT stop the campaign
 *      (unlike Facebook's D14, where one DISAPPROVED ad does): Whop never serves a rejected ad and the rest can still
 *      earn, so the buyer is only told, once per rejected ad, which ones and why.
 *   2. paused / resumed in Whop -> mirror ACTIVE <-> PAUSED so Analytics tells the truth. The channel is KEPT on pause.
 *   3. deleted in Whop -> ARCHIVED and stop routing to it, but only on the SECOND consecutive tick on which a direct
 *      read says 404 (the first leaves a `not_found` marker in `whop_delivery_status`): archiving is one-way and releases
 *      a channel, and one wrong answer from an API we only partly control must not do that to a live campaign.
 *   4. a billing failure is told to the buyer once (Whop keeps active/paused and simply stops delivering).
 * It also mirrors Whop's delivery word and its issues (Meta's rejections, in words) onto the campaign, and each ad /
 * ad group's display status, for the dashboard.
 *
 * STOPPING ROUTING (`stopRouting`) is two effects, in the one order that cannot misattribute: the edge config is
 * re-published first (it then stops emitting the channel), and only when that is done is the channel released (it can be
 * handed to someone else at once). Both can fail after the status has already moved, and a stopped campaign is not in the
 * scan any more, so `repairHeldChannels` (run first on every pass) finishes them: a stopped Whop campaign that still holds
 * a channel has work left. The buyer is told what actually happened, never that a channel was released when it was not.
 *
 * SAFE DEFAULTS. A state we are not sure of is never acted on. No usable connection, a rejected or unreadable key, a
 * Whop outage, a campaign whose ads we could not read, a campaign missing from a list we could not confirm with a direct
 * read: all are "skip, try next tick", never "archive" or "release". Only an explicit answer from a successful read
 * changes a campaign.
 *
 * NO LOST UPDATES. Every write is conditional on the row still being what this tick read: a status change is an
 * `updateMany` on (id, status, whop_campaign_id) and every mirror on the Whop id it is mirroring. A buyer who pauses in
 * our UI, or a relaunch that just swapped the Whop campaign, between this tick's read and its write loses nothing: the
 * write simply does not apply and the next tick sees the new state.
 *
 * It also settles a launch that died mid-way (the API process restarted, or could not save the result, while a campaign
 * was LAUNCHING). It never guesses: it asks Whop what became of the campaign. A live one is completed here (ACTIVE,
 * or PAUSED if paused meanwhile); one Whop never finished (still a draft, or nothing created) goes back to PROCESSING so
 * the buyer can launch again (everything Whop already created is reused, see `whop-launch.service.ts`); one it cannot read
 * is left alone, because resetting a campaign Whop may be spending on would route paid clicks to the white page.
 *
 * A pass is bounded: it stops starting new businesses after a time budget, and after several businesses in a row fail on
 * transport (Whop is down: a rate limit or a rejected key is Whop answering, so it does not count), so the cron never waits
 * on a slow Whop for hours. Businesses are visited in a rotating order, so an early stop never starves the same ones.
 */

interface Notification {
  orgId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
}

export interface WhopReconcileDeps {
  /** Whop Ads is on (`WHOP_ADS_ENABLED`). The company switch is NOT consulted: a live campaign must keep being watched. */
  enabled?: () => boolean;
  adsFor?: (conn: WhopConnectionRow) => WhopAdsApi;
  releaseChannel?: (campaignId: string) => Promise<unknown>;
  resync?: (campaignId: string) => Promise<unknown>;
  notify?: (n: Notification) => void;
  now?: () => Date;
  /** Stop starting new businesses after this long (ms). Default 5 min. */
  budgetMs?: number;
  /** The clock (ms) the budget runs on; tests move it. */
  clock?: () => number;
  /** Waits between the tries of a side effect; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
  /** Where in the (stable) order of businesses this pass starts, as a number in [0, 1). Random by default; tests fix it. */
  rand?: () => number;
}

export interface WhopReconcileResult {
  checked: number;
  rejected: number;
  statusSynced: number;
  subSynced: number;
  skipped: number;
  /** Launches that died mid-way and were settled (completed, or given back). */
  recovered: number;
  /** Stopped campaigns whose routing (edge config, channel) had not been fully stopped, and now is. */
  repaired: number;
}

interface Ctx {
  adsFor: (conn: WhopConnectionRow) => WhopAdsApi;
  releaseChannel: (campaignId: string) => Promise<unknown>;
  resync: (campaignId: string) => Promise<unknown>;
  notify: (n: Notification) => void;
  sleep: (ms: number) => Promise<void>;
  out: WhopReconcileResult;
}

/** A launch quiet for this long has died: a live one persists an id at least every couple of minutes (a video can take ~3). */
const STUCK_LAUNCH_MS = 15 * 60_000;

/** What the first missed direct read leaves in `whop_delivery_status`; a second consecutive miss acts on it. */
const MISSING = 'not_found';

/** A side effect after a status move is tried this many times, waiting a little longer each time (an API deploy takes seconds). */
const AFTER_MOVE_ATTEMPTS = 3;
const AFTER_MOVE_DELAY_MS = 1_000;

/** An issue as stored in `campaigns.whop_issues` (a JSON column, hence a type alias, which is assignable to Prisma's JSON input). */
type StoredIssue = {
  id: string;
  message: string;
  resource_id: string | null;
  resource_type: string;
};

const toIssues = (campaign: WhopAdCampaign, ads: readonly WhopAd[]): StoredIssue[] => {
  const seen = new Set<string>();
  const out: StoredIssue[] = [];
  for (const i of [...(campaign.issues ?? []), ...ads.flatMap((a) => a.issues ?? [])] as WhopIssue[]) {
    if (!i || typeof i.id !== 'string' || seen.has(i.id)) continue;
    seen.add(i.id);
    out.push({ id: i.id, message: i.message, resource_id: i.resource_id ?? null, resource_type: i.resource_type });
  }
  return out;
};

type IssueTuple = [id: string, message: string, resourceId: string | null, resourceType: string];

/**
 * Whop promises no order for issues, and Postgres hands JSON back with its own key order: compare them as a SET of fixed-shape
 * tuples, so neither a reshuffle nor a re-ordered object is a change (the cron must not churn rows).
 */
const issueKey = (issues: unknown): string => {
  const list = Array.isArray(issues) ? issues : [];
  const rows = list.map((i): IssueTuple => {
    const o = (i ?? {}) as Record<string, unknown>;
    return [String(o.id ?? ''), String(o.message ?? ''), o.resource_id == null ? null : String(o.resource_id), String(o.resource_type ?? '')];
  });
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(rows);
};

type CampaignRow = Awaited<ReturnType<typeof loadCampaigns>>[number];

async function loadCampaigns() {
  return withSystem((tx) =>
    tx.campaign.findMany({
      where: { adProvider: 'WHOP', whopCampaignId: { not: null }, status: { in: [CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED] } },
      select: {
        id: true,
        orgId: true,
        buyerId: true,
        name: true,
        status: true,
        whopCampaignId: true,
        whopConnectionId: true,
        whopBizId: true,
        whopDeliveryStatus: true,
        whopIssues: true,
        adSets: { select: { id: true, whopAdGroupId: true, effectiveStatus: true, ads: { select: { id: true, whopAdId: true, effectiveStatus: true } } } },
      },
    }),
  );
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A side effect that FOLLOWS a status change. The status has already moved, so this campaign leaves the scan: the effect is
 * tried a few times, and whether it worked is returned so the caller can say so honestly and `repairHeldChannels` can finish
 * what could not be done now.
 */
async function afterMove(label: string, campaignId: string, ctx: Ctx, fn: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= AFTER_MOVE_ATTEMPTS; attempt += 1) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (attempt === AFTER_MOVE_ATTEMPTS) console.error(`[whop-reconcile] ${label} failed for ${campaignId}: ${errText(err)}`);
      else await ctx.sleep(AFTER_MOVE_DELAY_MS * attempt);
    }
  }
  return false;
}

/**
 * Stop routing to a campaign that has just been stopped, in the one order that cannot misattribute: the edge config first
 * (it then stops emitting the channel), and only when that is done the channel is released (it can be handed to someone else
 * at once). If the edge could not be updated the channel stays held, which is what makes `repairHeldChannels` finish both on
 * a later pass. True when both are done.
 */
async function stopRouting(ctx: Ctx, campaignId: string): Promise<boolean> {
  if (!(await afterMove('edge KV resync', campaignId, ctx, () => ctx.resync(campaignId)))) return false;
  return afterMove('channel release', campaignId, ctx, () => ctx.releaseChannel(campaignId));
}

/**
 * Finish stopping routing for stopped Whop campaigns (rejected or archived) that still hold a channel. Such a campaign is not
 * in the scan any more, so nothing else would ever retry: the channel it still holds is the marker that work is left, and it
 * would otherwise sit out of a pool of only a few hundred and keep being emitted at the edge. Idempotent and cheap.
 */
async function repairHeldChannels(ctx: Ctx): Promise<number> {
  const held = await withSystem(async (tx) => {
    const channels = await tx.channel.findMany({ where: { currentCampaignId: { not: null } }, select: { currentCampaignId: true } });
    const ids = [...new Set(channels.map((c) => c.currentCampaignId as string))];
    if (ids.length === 0) return [];
    return tx.campaign.findMany({ where: { id: { in: ids }, adProvider: 'WHOP', status: { in: [CAMPAIGN_STATUS.META_REJECTED, CAMPAIGN_STATUS.ARCHIVED] } }, select: { id: true } });
  });
  let repaired = 0;
  for (const c of held) {
    try {
      if (await stopRouting(ctx, c.id)) repaired += 1;
    } catch (err) {
      console.error(`[whop-reconcile] could not finish stopping the routing of ${c.id}: ${errText(err)}`);
    }
  }
  return repaired;
}

/**
 * Flip a campaign's status if the state machine allows it from the status THIS TICK READ, and only if the row still has
 * that status and that Whop campaign. True when it changed. A row that changed under us is simply left for the next tick.
 */
async function move(c: Pick<CampaignRow, 'id' | 'status' | 'whopCampaignId'>, target: CampaignStatus): Promise<boolean> {
  if (c.status === target || !canTransitionCampaign(c.status, target)) return false;
  const res = await withSystem((tx) => tx.campaign.updateMany({ where: { id: c.id, status: c.status, whopCampaignId: c.whopCampaignId }, data: { status: target } }));
  return res.count === 1;
}

/** Write Whop's delivery word + issues onto the campaign and each ad / ad group's display status; only what changed. */
async function mirrorDisplay(c: CampaignRow, whop: WhopAdCampaign, whopAds: readonly WhopAd[]): Promise<{ changed: number; stale: boolean }> {
  const issues = toIssues(whop, whopAds);
  // A billing failure reported through `status` is recorded the same way as one reported through `delivery_status`, so the
  // stored word alone says "the buyer has been told" and the notice is sent once, not every tick.
  const delivery = whopBillingFailed(whop) ? 'payment_failed' : whop.delivery_status || null;
  const adStatus = new Map(whopAds.map((a) => [a.id, whopAdEffectiveStatus(a)]));
  let changed = 0;
  let stale = false;
  await withSystem(async (tx) => {
    if ((delivery !== null && delivery !== c.whopDeliveryStatus) || issueKey(issues) !== issueKey(c.whopIssues)) {
      const res = await tx.campaign.updateMany({
        where: { id: c.id, whopCampaignId: c.whopCampaignId },
        data: { ...(delivery !== null ? { whopDeliveryStatus: delivery } : {}), whopIssues: issues },
      });
      // The campaign no longer points at the Whop campaign we read (a relaunch swapped it): everything below is stale too.
      if (res.count === 0) {
        stale = true;
        return;
      }
      changed += 1;
    }
    for (const set of c.adSets) {
      const setAds: (string | null)[] = [];
      for (const ad of set.ads) {
        const next = ad.whopAdId ? adStatus.get(ad.whopAdId) ?? null : null;
        setAds.push(next);
        // `next &&` never overwrites a real status with a blank.
        if (ad.whopAdId && next && next !== (ad.effectiveStatus ?? '')) {
          const res = await tx.ad.updateMany({ where: { id: ad.id, whopAdId: ad.whopAdId }, data: { effectiveStatus: next } });
          changed += res.count;
        }
      }
      const setNext = whopAdGroupEffectiveStatus(setAds);
      if (setNext && setNext !== (set.effectiveStatus ?? '')) {
        const res = await tx.adSet.updateMany({ where: { id: set.id, whopAdGroupId: set.whopAdGroupId }, data: { effectiveStatus: setNext } });
        changed += res.count;
      }
    }
  });
  return { changed, stale };
}

/** Stop a rejected campaign at Whop too: our redirect no longer sends it traffic, so a still-delivering ad would only burn money. */
async function pauseAtWhop(ads: WhopAdsApi, whopCampaignId: string): Promise<boolean> {
  try {
    await ads.pauseCampaign(whopCampaignId);
    return true;
  } catch (err) {
    console.warn(`[whop-reconcile] could not pause rejected campaign ${whopCampaignId} at Whop: ${errText(err)}`);
    return false;
  }
}

async function onRejected(ctx: Ctx, ads: WhopAdsApi, c: CampaignRow, whop: WhopAdCampaign, whopAds: readonly WhopAd[]): Promise<void> {
  if (!(await move(c, CAMPAIGN_STATUS.META_REJECTED))) return;
  const paused = whop.status === 'paused' || (await pauseAtWhop(ads, c.whopCampaignId!));
  const stopped = await stopRouting(ctx, c.id);
  const why = toIssues(whop, whopAds)[0]?.message;
  const here = stopped ? 'stopped here and its channel released' : 'stopped here (releasing its channel is retried automatically)';
  ctx.notify({
    orgId: c.orgId,
    userId: c.buyerId,
    type: 'campaign.meta_rejected',
    title: 'Campaign rejected by Meta',
    body: `"${c.name}" was rejected in Meta's ad review on Whop${why ? ` (${why})` : ''}; ${
      paused
        ? `it is paused in Whop, ${here}.`
        : `it's been ${here}. We could not pause it in Whop: pause it there too, or it keeps spending on clicks we no longer send to the article.`
    }`,
  });
  ctx.out.rejected += 1;
}

/** Whop has no campaign by this id. The FIRST such read only leaves a marker; the second, one tick later, archives. */
async function onMissing(ctx: Ctx, c: CampaignRow): Promise<void> {
  if (c.whopDeliveryStatus !== MISSING) {
    await withSystem((tx) => tx.campaign.updateMany({ where: { id: c.id, whopCampaignId: c.whopCampaignId, status: c.status }, data: { whopDeliveryStatus: MISSING } }));
    return;
  }
  if (!(await move(c, CAMPAIGN_STATUS.ARCHIVED))) return;
  const stopped = await stopRouting(ctx, c.id);
  ctx.notify({
    orgId: c.orgId,
    userId: c.buyerId,
    type: 'campaign.status_synced',
    title: 'Campaign archived',
    body: `"${c.name}" was deleted in Whop; it's been archived here and ${stopped ? 'its channel released.' : 'its channel is released as soon as its redirect update goes through (retried automatically).'}`,
  });
  ctx.out.statusSynced += 1;
}

/**
 * Some (not all) of a campaign's ads were rejected by Meta: the campaign keeps running, but the buyer should know which ads
 * will never deliver. Told once per ad: an ad whose stored display status was already DISAPPROVED has been announced (the
 * mirror that stores it runs only after this read, and this is called only when that mirror succeeded, so a failed write never
 * repeats the notice the next tick).
 */
function tellAboutRejectedAds(ctx: Ctx, c: CampaignRow, whopAds: readonly WhopAd[]): void {
  const told = new Set(c.adSets.flatMap((s) => s.ads.filter((a) => a.whopAdId && a.effectiveStatus === 'DISAPPROVED').map((a) => a.whopAdId as string)));
  const rejected = whopAds.filter((a) => whopAdEffectiveStatus(a) === 'DISAPPROVED');
  const fresh = rejected.filter((a) => !told.has(a.id));
  if (fresh.length === 0 || rejected.length === whopAds.length) return;
  const ids = new Set(fresh.map((a) => a.id));
  const reasons = [...new Set(whopAds.filter((a) => ids.has(a.id)).flatMap((a) => (a.issues ?? []).map((i) => i.message)).filter((m): m is string => Boolean(m)))];
  ctx.notify({
    orgId: c.orgId,
    userId: c.buyerId,
    type: 'campaign.ads_rejected',
    title: 'Some ads were rejected by Meta',
    body: `${rejected.length} of ${whopAds.length} ads in "${c.name}" were rejected in Meta's ad review on Whop${reasons[0] ? ` (${reasons[0].slice(0, 160)})` : ''}. The campaign keeps running with the others; edit or replace the rejected ads in Whop.`,
  });
}

/** Everything one campaign needs once Whop has answered for it. */
async function reconcileKnown(ctx: Ctx, conn: WhopConnectionRow, ads: WhopAdsApi, c: CampaignRow, whop: WhopAdCampaign, whopAds: readonly WhopAd[]): Promise<void> {
  ctx.out.checked += 1;

  // 0) Mirror Whop's words (display only) whatever the outcome below, so a campaign about to be rejected still records which
  //    ad was. A mirror that cannot be written is not fatal, but nothing is announced on the strength of it.
  let mirrored = false;
  try {
    const m = await mirrorDisplay(c, whop, whopAds);
    if (m.stale) return;
    ctx.out.subSynced += m.changed;
    mirrored = true;
  } catch (err) {
    console.warn(`[whop-reconcile] display sync failed for ${c.id}: ${errText(err)}`);
  }

  // A billing failure is told once, when it starts: the mirror just recorded `payment_failed`, which is what stops the repeat.
  if (mirrored && whopBillingFailed(whop) && c.whopDeliveryStatus !== 'payment_failed') {
    ctx.notify({
      orgId: c.orgId,
      userId: c.buyerId,
      type: 'whop_payment_failed',
      title: 'Whop could not charge your ads payment method',
      body: `"${c.name}" stopped delivering because Whop could not charge the payment method on ${conn.bizId}. Update it in Whop; delivery resumes once the charge goes through.`,
    });
  }

  const target = whopSyncTarget(whop, whopAds);
  if (mirrored && target !== CAMPAIGN_STATUS.META_REJECTED) tellAboutRejectedAds(ctx, c, whopAds);
  if (!target) return;

  if (target === CAMPAIGN_STATUS.META_REJECTED) {
    await onRejected(ctx, ads, c, whop, whopAds);
    return;
  }

  if (await move(c, target)) {
    // The redirect's `active` flag follows the status; pausing KEEPS the channel, so this is only the edge.
    if (!(await afterMove('edge KV resync', c.id, ctx, () => ctx.resync(c.id)))) {
      // The edge did not follow. A resumed campaign whose edge still says "inactive" would send paid clicks to the white page
      // while it runs, and nothing would ever retry (the status now matches Whop): so the status is given back, the database
      // and the edge agree again, and the next tick does the whole thing over. Announce nothing.
      await withSystem((tx) => tx.campaign.updateMany({ where: { id: c.id, status: target, whopCampaignId: c.whopCampaignId }, data: { status: c.status } }));
      return;
    }
    const resumed = target === CAMPAIGN_STATUS.ACTIVE;
    ctx.notify({
      orgId: c.orgId,
      userId: c.buyerId,
      type: 'campaign.status_synced',
      title: resumed ? 'Campaign resumed' : 'Campaign paused',
      body: `"${c.name}" was ${resumed ? 'resumed' : 'paused'} in Whop; the change is now reflected here.`,
    });
    ctx.out.statusSynced += 1;
  }
}

/** `transport`: Whop did not answer. `answered`: it did, whatever it said. `skipped`: we could not even try. */
type Outcome = 'transport' | 'answered' | 'skipped';

/** One business: read once, reconcile each of its campaigns, contain every failure to the campaign (or business) it belongs to. */
async function reconcileBusiness(ctx: Ctx, conn: WhopConnectionRow, group: CampaignRow[]): Promise<Outcome> {
  const skipAll = (why: string): void => {
    ctx.out.skipped += group.length;
    console.error(`[whop-reconcile] ${why}`);
  };

  let ads: WhopAdsApi;
  try {
    ads = ctx.adsFor(conn);
  } catch (err) {
    skipAll(`cannot use the Whop key of ${conn.bizId}: ${errText(err)}`);
    return 'skipped';
  }

  let byId: Map<string, WhopAdCampaign>;
  try {
    byId = new Map((await ads.listCampaigns({ accountId: conn.bizId })).map((w) => [w.id, w]));
  } catch (err) {
    const kind = await handleWhopReadFailure(conn, err);
    skipAll(`read failed for ${conn.bizId} (${kind}): ${errText(err)}`);
    return kind === 'transport' ? 'transport' : 'answered';
  }

  // An ad belongs to the campaign OUR rows say it does; Whop's own pointer is only the fallback (never trust one field of an
  // API we only partly control to decide which campaign gets rejected).
  const campaignOfAd = new Map<string, string>();
  for (const c of group) for (const set of c.adSets) for (const ad of set.ads) if (ad.whopAdId) campaignOfAd.set(ad.whopAdId, c.whopCampaignId!);
  const adsByCampaign = new Map<string, WhopAd[]>();
  const collect = (list: readonly WhopAd[]): void => {
    for (const a of list) {
      const owner = campaignOfAd.get(a.id) ?? a.ad_campaign?.id;
      if (owner) adsByCampaign.set(owner, [...(adsByCampaign.get(owner) ?? []), a]);
    }
  };

  // Ads are asked for only for campaigns Whop listed: one id it does not know can make a whole batch refuse.
  const listed = group.filter((c) => byId.has(c.whopCampaignId!)).map((c) => c.whopCampaignId!);
  const unread = new Set<string>(); // campaigns whose ads we could not read: never decided on
  if (listed.length > 0) {
    try {
      collect(await ads.listAds({ accountId: conn.bizId, campaignIds: listed }));
    } catch (err) {
      const kind = await handleWhopReadFailure(conn, err);
      if (kind !== 'other') {
        skipAll(`ads read failed for ${conn.bizId} (${kind}): ${errText(err)}`);
        return kind === 'transport' ? 'transport' : 'answered';
      }
      // Whop refused the batch (one campaign it does not like): read each campaign's ads on its own.
      for (const id of listed) {
        try {
          collect(await ads.listAds({ accountId: conn.bizId, campaignIds: [id] }));
        } catch (e) {
          unread.add(id);
          console.warn(`[whop-reconcile] could not read the ads of ${id}: ${errText(e)}`);
        }
      }
    }
  }

  let streak = 0; // consecutive transport failures inside this business
  for (const [i, c] of group.entries()) {
    if (streak >= TRANSPORT_FAILURES_BEFORE_STOP) {
      ctx.out.skipped += group.length - i;
      return 'transport';
    }
    const id = c.whopCampaignId!;
    try {
      let whop = byId.get(id);
      let whopAds = adsByCampaign.get(id) ?? [];
      if (!whop) {
        // Missing from the list is not proof it is gone (paging, filtering): ask for it directly.
        try {
          whop = await ads.getCampaign(id);
        } catch (err) {
          if (isWhopError(err) && err.kind === 'not_found') {
            ctx.out.checked += 1;
            streak = 0;
            await onMissing(ctx, c);
            continue;
          }
          const kind = await handleWhopReadFailure(conn, err);
          ctx.out.skipped += 1;
          console.error(`[whop-reconcile] could not read ${id} (${kind}): ${errText(err)}`);
          // A rejected key, or a rate limit on this key, would fail every remaining campaign of the business the same way.
          if (kind === 'fatal' || kind === 'limited') {
            ctx.out.skipped += group.length - i - 1;
            return 'answered';
          }
          if (kind === 'transport') streak += 1;
          continue;
        }
        try {
          collect(await ads.listAds({ accountId: conn.bizId, campaignIds: [id] }));
          whopAds = adsByCampaign.get(id) ?? [];
        } catch (err) {
          unread.add(id);
          console.warn(`[whop-reconcile] could not read the ads of ${id}: ${errText(err)}`);
        }
      }
      if (unread.has(id)) {
        ctx.out.skipped += 1;
        continue;
      }
      streak = 0;
      await reconcileKnown(ctx, conn, ads, c, whop, whopAds);
    } catch (err) {
      ctx.out.skipped += 1;
      console.error(`[whop-reconcile] ${c.id} (${id}) failed: ${errText(err)}`);
    }
  }
  return streak > 0 ? 'transport' : 'answered';
}

interface Group {
  /** A stable sort key: the connection, or, for a campaign with none, the campaign. */
  key: string;
  conn: WhopConnectionRow | null;
  campaigns: CampaignRow[];
}

/** One connection (and so one bulk read) per business; the same business is resolved once, not once per campaign. */
async function groupByBusiness(campaigns: readonly CampaignRow[]): Promise<Group[]> {
  const groups = new Map<string, Group>();
  const resolved = new Map<string, WhopConnectionRow | null>();
  for (const c of campaigns) {
    const refKey = `${c.whopConnectionId ?? ''}|${c.orgId}|${c.buyerId}|${c.whopBizId ?? ''}`;
    if (!resolved.has(refKey)) resolved.set(refKey, await resolveWhopConnection(c));
    const conn = resolved.get(refKey) ?? null;
    const key = conn?.id ?? `none:${c.id}`;
    const g = groups.get(key) ?? { key, conn, campaigns: [] };
    g.campaigns.push(c);
    groups.set(key, g);
  }
  return [...groups.values()];
}

type Stuck = Awaited<ReturnType<typeof loadStuck>>[number];

async function loadStuck(cutoff: Date) {
  return withSystem((tx) =>
    tx.campaign.findMany({
      where: {
        adProvider: 'WHOP',
        status: CAMPAIGN_STATUS.LAUNCHING,
        updatedAt: { lt: cutoff },
        // A launch touches the campaign row each time it saves an id; a tree part written since the cutoff also says "alive".
        adSets: { none: { OR: [{ updatedAt: { gte: cutoff } }, { ads: { some: { updatedAt: { gte: cutoff } } } }] } },
      },
      select: { id: true, orgId: true, buyerId: true, name: true, updatedAt: true, whopCampaignId: true, whopConnectionId: true, whopBizId: true, whopDeliveryStatus: true },
    }),
  );
}

type Verdict =
  | { kind: 'wait' }
  /** Nothing is live at Whop: the launch can simply be run again. */
  | { kind: 'reset' }
  /** Whop launched it: complete the launch here. */
  | { kind: 'live'; paused: boolean; delivery: string | null; issues: StoredIssue[]; whopCampaignId: string };

/**
 * What became of a launch that went quiet, from Whop's own word. Mirrors what the launch itself would have saved
 * (`resultOf` in `whop-launch.service.ts`): past draft = launched, paused = paused. Unreadable = wait.
 */
async function launchVerdict(ctx: Ctx, c: Stuck): Promise<Verdict> {
  if (!c.whopCampaignId) return { kind: 'reset' };
  const conn = await resolveWhopConnection(c);
  if (!conn || conn.status === WhopConnectionStatus.BROKEN) return { kind: 'wait' };
  let ads: WhopAdsApi;
  try {
    ads = ctx.adsFor(conn);
  } catch (err) {
    console.error(`[whop-reconcile] cannot use the Whop key of ${conn.bizId}: ${errText(err)}`);
    return { kind: 'wait' };
  }
  try {
    const whop = await ads.getCampaign(c.whopCampaignId);
    if (whop.status === 'draft') return { kind: 'reset' }; // never activated: nothing spends, and a relaunch continues from its ids
    return { kind: 'live', paused: whop.status === 'paused', delivery: whop.delivery_status || null, issues: toIssues(whop, []), whopCampaignId: c.whopCampaignId };
  } catch (err) {
    if (isWhopError(err) && err.kind === 'not_found') {
      // Same two-strike rule as a deleted campaign: the first miss leaves the marker, the second lets the launch be rebuilt.
      if (c.whopDeliveryStatus === MISSING) return { kind: 'reset' };
      // `updatedAt` is held where it was: writing the marker must not make the launch look alive for another 15 minutes.
      await withSystem((tx) =>
        tx.campaign.updateMany({ where: { id: c.id, status: CAMPAIGN_STATUS.LAUNCHING, whopCampaignId: c.whopCampaignId }, data: { whopDeliveryStatus: MISSING, updatedAt: c.updatedAt } }),
      );
      return { kind: 'wait' };
    }
    const kind = await handleWhopReadFailure(conn, err);
    console.warn(`[whop-reconcile] cannot tell whether the launch of ${c.id} finished (${kind}): ${errText(err)}`);
    return { kind: 'wait' };
  }
}

/** Settle a launch that died mid-way. True when it was settled (completed or given back). */
async function settleStuckLaunch(ctx: Ctx, c: Stuck, cutoff: Date): Promise<boolean> {
  const verdict = await launchVerdict(ctx, c);
  if (verdict.kind === 'wait') return false;

  // Re-check in the UPDATE itself: a launch that just persisted an id is alive and must not be disturbed. LAUNCHING has no
  // legal edge to PROCESSING/PAUSED in the state table (the launches themselves give a claim back the same way), so these are
  // conditional writes, not `move`s.
  const stillStuck = { id: c.id, adProvider: 'WHOP' as const, status: CAMPAIGN_STATUS.LAUNCHING, updatedAt: { lt: cutoff } };
  if (verdict.kind === 'reset') {
    const res = await withSystem((tx) => tx.campaign.updateMany({ where: { ...stillStuck, whopCampaignId: c.whopCampaignId }, data: { status: CAMPAIGN_STATUS.PROCESSING } }));
    if (res.count === 0) return false;
    // The launch wrote its edge config ACTIVE for Whop's pixel check; with the status back to PROCESSING this derives inactive.
    await afterMove('edge KV resync', c.id, ctx, () => ctx.resync(c.id));
    ctx.notify({
      orgId: c.orgId,
      userId: c.buyerId,
      type: 'whop_launch_failed',
      title: 'A Whop launch was interrupted',
      body: `"${c.name}" stopped part-way while launching on Whop. Launch it again: everything Whop already created is reused.`,
    });
    return true;
  }

  const res = await withSystem(async (tx) => {
    const done = await tx.campaign.updateMany({
      where: { ...stillStuck, whopCampaignId: verdict.whopCampaignId },
      data: { status: verdict.paused ? CAMPAIGN_STATUS.PAUSED : CAMPAIGN_STATUS.ACTIVE, ...(verdict.delivery ? { whopDeliveryStatus: verdict.delivery } : {}), whopIssues: verdict.issues },
    });
    if (done.count === 1) {
      await tx.auditLog.create({
        data: { orgId: c.orgId, action: 'campaign.launched', entityType: 'campaign', entityId: c.id, details: { provider: 'WHOP', whopCampaignId: verdict.whopCampaignId, completedBy: 'status-sync' } },
      });
    }
    return done;
  });
  if (res.count === 0) return false;
  await afterMove('edge KV resync', c.id, ctx, () => ctx.resync(c.id));
  ctx.notify(
    verdict.paused
      ? { orgId: c.orgId, userId: c.buyerId, type: 'campaign.status_synced', title: 'Campaign launched, then paused', body: `"${c.name}" finished launching on Whop and is paused there. Resume it from here or in Whop when you are ready.` }
      : { orgId: c.orgId, userId: c.buyerId, type: 'campaign.live', title: 'Campaign is live', body: `"${c.name}" is now live on Whop. Meta reviews new ads first, so delivery can take a while to start.` },
  );
  return true;
}

async function recoverStuckLaunches(ctx: Ctx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_LAUNCH_MS);
  let recovered = 0;
  for (const c of await loadStuck(cutoff)) {
    try {
      if (await settleStuckLaunch(ctx, c, cutoff)) recovered += 1;
    } catch (err) {
      console.error(`[whop-reconcile] could not settle the launch of ${c.id}: ${errText(err)}`);
    }
  }
  return recovered;
}

export async function reconcileWhopCampaigns(deps: WhopReconcileDeps = {}): Promise<WhopReconcileResult> {
  const enabled = deps.enabled ?? ((): boolean => env.WHOP_ADS_ENABLED);
  const now = (deps.now ?? (() => new Date()))();

  const out: WhopReconcileResult = { checked: 0, rejected: 0, statusSynced: 0, subSynced: 0, skipped: 0, recovered: 0, repaired: 0 };
  if (!enabled()) return out;
  const ctx: Ctx = {
    adsFor: deps.adsFor ?? whopAdsForConnection,
    releaseChannel: deps.releaseChannel ?? releaseChannelForCampaign,
    resync: deps.resync ?? resyncOffersToKv,
    notify: deps.notify ?? sendNotification,
    sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    out,
  };
  const budget = new PassBudget(deps.budgetMs ?? 5 * 60_000, deps.clock);

  // First, before anything new can go wrong this pass: settle what earlier passes could not finish.
  out.repaired = await repairHeldChannels(ctx).catch((err: unknown) => {
    console.error(`[whop-reconcile] channel repair failed: ${errText(err)}`);
    return 0;
  });
  out.recovered = await recoverStuckLaunches(ctx, now);

  const groups = rotate(
    (await groupByBusiness(await loadCampaigns())).sort((a, b) => a.key.localeCompare(b.key)),
    (deps.rand ?? Math.random)(),
  );
  let transportFailures = 0;
  for (const [i, g] of groups.entries()) {
    // No connection, or one whose key is known bad: nothing can be read, and "cannot read" is never "gone".
    if (!g.conn || g.conn.status === WhopConnectionStatus.BROKEN) {
      out.skipped += g.campaigns.length;
      continue;
    }
    if (budget.expired() || transportFailures >= TRANSPORT_FAILURES_BEFORE_STOP) {
      const left = groups.slice(i).reduce((n, x) => n + x.campaigns.length, 0);
      out.skipped += left;
      console.warn(
        budget.expired()
          ? `[whop-reconcile] time budget reached, ${left} campaign(s) are left for the next run`
          : `[whop-reconcile] ${transportFailures} businesses in a row failed to answer, stopping this pass (${left} campaign(s) left)`,
      );
      break;
    }
    transportFailures = nextTransportFailures(transportFailures, await reconcileBusiness(ctx, g.conn, g.campaigns));
  }
  return out;
}
