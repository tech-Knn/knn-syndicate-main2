import { withSystem } from '@knn/db';
import { QUEUES, getQueue } from '@knn/queue';
import { pxeToFbEvent } from '@knn/shared';
import { type ClickRecord, readClick as defaultReadClick } from '../../lib/kv-sync.js';

/**
 * Conversion ingest (RSOC final ad-click). The /search page beacons here with the
 * click id (txid). We resolve that click (edge KV) → the ad → its pixel + the owning
 * campaign/buyer, record a `ConversionEvent` (deduped on the click id), and enqueue a
 * CAPI dispatch job. The pixel + token are derived SERVER-SIDE from the click — never
 * trusted from the caller (the beacon is public/unauthenticated). All DB work runs
 * under `withSystem`: there's no tenant session, and the org is resolved from the click.
 */

export interface ConversionInput {
  clickId: string;
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

async function defaultEnqueueDispatch(conversionEventId: string): Promise<void> {
  await getQueue(QUEUES.CAPI_DISPATCH).add(
    'dispatch',
    { conversionEventId },
    { jobId: `capi:${conversionEventId}`, attempts: 5, backoff: { type: 'exponential', delay: 15_000 }, removeOnComplete: 500, removeOnFail: 500 },
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

  const result = await withSystem(async (tx) => {
    // Dedup: a click converts at most once.
    const existing = await tx.conversionEvent.findUnique({ where: { clickId: input.clickId }, select: { id: true } });
    if (existing) return { id: existing.id, deduped: true, status: 'existing' as const };

    const ad = await tx.ad.findUnique({
      where: { redirectId: click.redirectId },
      select: { id: true, orgId: true, adSet: { select: { campaignId: true, pixelId: true, pxeEvent: true } } },
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
        eventName: pxeToFbEvent(ad.adSet.pxeEvent),
        valueMinor: input.valueMinor ?? null,
        currency: input.currency || 'USD',
        clientIp: input.clientIp ?? null,
        clientUa: input.clientUa ?? null,
        eventSourceUrl: input.url ?? null,
        eventTime: new Date(),
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
