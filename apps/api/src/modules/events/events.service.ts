import { env } from '@knn/config';
import { FbConnectionStatus, WhopConnectionStatus, withSystem } from '@knn/db';
import { QUEUES, getQueue } from '@knn/queue';
import { type FunnelStage, MAIN_CONVERSION_STAGE, WHOP_BIZ_ID_RE, pxeToFbEvent } from '@knn/shared';
import { type ClickRecord, readClick as defaultReadClick } from '../../lib/kv-sync.js';

/**
 * Conversion ingest (RSOC funnel). The article funnel beacons here at each stage with
 * the click id (txid) + the stage: `lander` (article view → ViewContent), `search`
 * (/search reached → AddToCart), `adclick` (AFS ad clicked → Search, the MAIN event).
 * We resolve the click (edge KV) → the ad → its pixel + owning campaign/buyer, record a
 * `ConversionEvent` (deduped on (clickId, eventName) — a click fires each event once),
 * and enqueue a CAPI dispatch job. The pixel + token are derived SERVER-SIDE from the
 * click — never trusted from the caller (the beacon is public/unauthenticated). All DB
 * work runs under `withSystem`: there's no tenant session, org resolved from the click.
 */

export interface ConversionInput {
  clickId: string;
  /** Which funnel event fired (defaults to the main, 'adclick'). */
  stage?: FunnelStage;
  valueMinor?: number;
  currency?: string;
  url?: string;
  clientIp?: string;
  clientUa?: string;
}

export interface ConversionDeps {
  readClick: (txid: string) => Promise<ClickRecord | null>;
  enqueueDispatch: (conversionEventId: string) => Promise<void>;
  /** Whop's sibling of `enqueueDispatch` (D32). Only called for a Whop click; defaults to the real queue. */
  enqueueWhopDispatch?: (conversionEventId: string) => Promise<void>;
}

/**
 * De-dupe key for a conversion's CAPI dispatch job. BullMQ forbids ':' in a custom job
 * id (it's their Redis key separator → throws "Custom Id cannot contain :"), so the
 * prefix is '-'-joined, NOT ':'-joined. Keep it colon-free (guarded by a test).
 */
export const capiJobId = (conversionEventId: string): string => `capi-${conversionEventId}`;

/** De-dupe key for a conversion's Whop dispatch job. Colon-free for the same BullMQ reason as `capiJobId`. */
export const whopJobId = (conversionEventId: string): string => `whop-${conversionEventId}`;

async function defaultEnqueueWhopDispatch(conversionEventId: string): Promise<void> {
  await getQueue(QUEUES.WHOP_DISPATCH).add(
    'dispatch',
    { conversionEventId },
    { jobId: whopJobId(conversionEventId), attempts: 5, backoff: { type: 'exponential', delay: 15_000 }, removeOnComplete: 500, removeOnFail: 500 },
  );
}

async function defaultEnqueueDispatch(conversionEventId: string): Promise<void> {
  await getQueue(QUEUES.CAPI_DISPATCH).add(
    'dispatch',
    { conversionEventId },
    { jobId: capiJobId(conversionEventId), attempts: 5, backoff: { type: 'exponential', delay: 15_000 }, removeOnComplete: 500, removeOnFail: 500 },
  );
}

const defaultDeps: ConversionDeps = { readClick: defaultReadClick, enqueueDispatch: defaultEnqueueDispatch, enqueueWhopDispatch: defaultEnqueueWhopDispatch };

export type ConversionResult =
  | { recorded: false; reason: 'unknown_click' | 'unknown_ad' }
  | { recorded: true; deduped: boolean; dispatched: boolean };

/**
 * Record a conversion for a click. Idempotent on `clickId` (a click converts once).
 * Returns a small result; the public route maps everything to 204 regardless.
 */
export async function recordConversion(
  input: ConversionInput,
  deps: ConversionDeps = defaultDeps,
): Promise<ConversionResult> {
  const click = await deps.readClick(input.clickId);
  if (!click) return { recorded: false, reason: 'unknown_click' };

  // The recorded Facebook event is determined by the FUNNEL STAGE, not the ad set
  // (the ad set's pxeEvent is only the optimization target / custom_event_type).
  const stage: FunnelStage = input.stage ?? MAIN_CONVERSION_STAGE;
  const eventName = pxeToFbEvent(stage);

  const result = await withSystem(async (tx) => {
    // Dedup: a click fires each funnel event at most once (composite unique).
    const existing = await tx.conversionEvent.findUnique({
      where: { clickId_eventName: { clickId: input.clickId, eventName } },
      select: { id: true },
    });
    if (existing) return { id: existing.id, deduped: true, status: 'existing' as const, provider: 'facebook' as const };

    const ad = await tx.ad.findUnique({
      where: { redirectId: click.redirectId },
      select: { id: true, orgId: true, adSet: { select: { campaignId: true, pixelId: true } } },
    });
    if (!ad) return null;

    // A Whop ad's click (the redirect Worker wrote a `whop` block: the link belongs to a Whop business)
    // is reported to Whop's Events API instead of Facebook's CAPI (D32). One row is one send: it is never
    // also a CAPI row, and it is still exactly one row for Analytics (D30) either way.
    const whopBizId = click.whop?.bizId && WHOP_BIZ_ID_RE.test(click.whop.bizId) ? click.whop.bizId : undefined;
    let pixelFbId = '';
    let status: 'pending' | 'skipped';
    if (click.whop) {
      // Sent only while Whop Ads is on and the business still has a live connection; otherwise the event
      // is recorded (first-party signal kept) and skipped, like a Facebook click with no usable pixel.
      const connection =
        whopBizId && env.WHOP_ADS_ENABLED
          ? await tx.whopConnection.findFirst({ where: { orgId: ad.orgId, bizId: whopBizId, status: WhopConnectionStatus.ACTIVE }, select: { id: true } })
          : null;
      status = connection ? 'pending' : 'skipped';
    } else {
      const pixel = ad.adSet.pixelId
        ? await tx.fbPixel.findUnique({ where: { id: ad.adSet.pixelId }, select: { fbPixelId: true } })
        : null;
      pixelFbId = pixel?.fbPixelId ?? '';

      // Resolve the campaign's owning FB connection and check it's alive BEFORE queuing CAPI.
      // A campaign paused on our side can still be live on Facebook (e.g. its account is
      // checkpointed and couldn't be paused in Ads Manager), so conversions keep beaconing in.
      // Firing CAPI against a dead token just burns a failed 190 call per conversion against the
      // app-wide Marketing API error-rate quota. So record the event (first-party signal kept)
      // but SKIP dispatch when the connection is broken/expired.
      const campaign = await tx.campaign.findUnique({
        where: { id: ad.adSet.campaignId },
        select: { adAccountId: true },
      });
      const conn = campaign?.adAccountId
        ? (
            await tx.fbAdAccount.findUnique({
              where: { id: campaign.adAccountId },
              select: { connection: { select: { status: true, tokenExpiresAt: true } } },
            })
          )?.connection ?? null
        : null;
      const connectionDead =
        !conn ||
        conn.status === FbConnectionStatus.CONNECTION_BROKEN ||
        conn.tokenExpiresAt.getTime() <= Date.now();

      // Dispatch only when we have a pixel AND a live connection to send it with.
      status = pixelFbId && !connectionDead ? 'pending' : 'skipped';
    }

    const created = await tx.conversionEvent.create({
      data: {
        orgId: ad.orgId,
        campaignId: ad.adSet.campaignId,
        adId: ad.id,
        clickId: input.clickId,
        fbclid: click.fbclid ?? null,
        pixelFbId,
        eventName,
        valueMinor: input.valueMinor ?? null,
        currency: input.currency || 'USD',
        // Prefer the click-time IP captured at the Cloudflare edge (CF-Connecting-IP,
        // stored in KV by the redirect Worker) — that's the IP Facebook saw when they
        // issued the fbclid, so it's the strongest match signal. Fall back to the
        // beacon-time req.ip only for legacy KV records that predate `clientIp` capture.
        clientIp: click.clientIp ?? input.clientIp ?? null,
        clientUa: input.clientUa ?? null,
        eventSourceUrl: input.url ?? null,
        eventTime: new Date(),
        // The original FB-ad-click time (from the edge KV `click:{txid}` record) — feeds
        // `fbc`'s middle field. Old KV records lack `ts` on the record, but every current
        // record has it (worker.ts always writes it), so this is effectively always set.
        clickTimeMs: click.ts ? BigInt(click.ts) : null,
        // Server-minted `_fbp` from the edge (nullable — legacy KV records may omit it).
        fbp: click.fbp ?? null,
        // Whop (D32): what the dispatch job needs, frozen now because the job cannot read the edge KV.
        ...(click.whop
          ? {
              provider: 'whop',
              providerContext: { bizId: whopBizId ?? null, landing: click.whop.landing ?? null, click: click.whop.click ?? null },
            }
          : {}),
        status,
      },
      select: { id: true },
    });
    return { id: created.id, deduped: false, status, provider: click.whop ? ('whop' as const) : ('facebook' as const) };
  });

  if (!result) return { recorded: false, reason: 'unknown_ad' };
  if (!result.deduped && result.status === 'pending') {
    await (result.provider === 'whop' ? (deps.enqueueWhopDispatch ?? defaultEnqueueWhopDispatch) : deps.enqueueDispatch)(result.id);
    return { recorded: true, deduped: false, dispatched: true };
  }
  return { recorded: true, deduped: result.deduped, dispatched: false };
}
