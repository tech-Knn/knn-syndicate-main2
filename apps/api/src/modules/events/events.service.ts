import { withSystem } from '@knn/db';
import { QUEUES, getQueue } from '@knn/queue';
import { type FunnelStage, MAIN_CONVERSION_STAGE, pxeToFbEvent } from '@knn/shared';
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
}

/**
 * De-dupe key for a conversion's CAPI dispatch job. BullMQ forbids ':' in a custom job
 * id (it's their Redis key separator → throws "Custom Id cannot contain :"), so the
 * prefix is '-'-joined, NOT ':'-joined. Keep it colon-free (guarded by a test).
 */
export const capiJobId = (conversionEventId: string): string => `capi-${conversionEventId}`;

async function defaultEnqueueDispatch(conversionEventId: string): Promise<void> {
  await getQueue(QUEUES.CAPI_DISPATCH).add(
    'dispatch',
    { conversionEventId },
    { jobId: capiJobId(conversionEventId), attempts: 5, backoff: { type: 'exponential', delay: 15_000 }, removeOnComplete: 500, removeOnFail: 500 },
  );
}

const defaultDeps: ConversionDeps = { readClick: defaultReadClick, enqueueDispatch: defaultEnqueueDispatch };

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
    if (existing) return { id: existing.id, deduped: true, status: 'existing' as const };

    const ad = await tx.ad.findUnique({
      where: { redirectId: click.redirectId },
      select: { id: true, orgId: true, adSet: { select: { campaignId: true, pixelId: true } } },
    });
    if (!ad) return null;

    const pixel = ad.adSet.pixelId
      ? await tx.fbPixel.findUnique({ where: { id: ad.adSet.pixelId }, select: { fbPixelId: true } })
      : null;
    const pixelFbId = pixel?.fbPixelId ?? '';
    // No pixel → still record (first-party D8 signal) but skip CAPI dispatch.
    const status = pixelFbId ? 'pending' : 'skipped';

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
        clientIp: input.clientIp ?? null,
        clientUa: input.clientUa ?? null,
        eventSourceUrl: input.url ?? null,
        eventTime: new Date(),
        // The original FB-ad-click time (from the edge KV `click:{txid}` record) — feeds
        // `fbc`'s middle field. Old KV records lack `ts` on the record, but every current
        // record has it (worker.ts always writes it), so this is effectively always set.
        clickTimeMs: click.ts ? BigInt(click.ts) : null,
        // Server-minted `_fbp` from the edge (nullable — legacy KV records may omit it).
        fbp: click.fbp ?? null,
        status,
      },
      select: { id: true },
    });
    return { id: created.id, deduped: false, status };
  });

  if (!result) return { recorded: false, reason: 'unknown_ad' };
  if (!result.deduped && result.status === 'pending') {
    await deps.enqueueDispatch(result.id);
    return { recorded: true, deduped: false, dispatched: true };
  }
  return { recorded: true, deduped: result.deduped, dispatched: false };
}
