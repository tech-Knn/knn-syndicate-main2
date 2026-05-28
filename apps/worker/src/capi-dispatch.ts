import { FbConnectionStatus, withSystem } from '@knn/db';
import {
  type CapiEvent,
  FbConnectionBrokenError,
  FbRateLimitError,
  decryptToken,
  sendConversionEvent,
} from '@knn/fb';
import { buildFbc } from '@knn/shared';

/**
 * CAPI dispatch (conversion tracking). Processes one `CAPI_DISPATCH` job: take a
 * pending `ConversionEvent`, resolve the owning buyer's Facebook token (campaign →
 * buyer → connection), build the Conversions API event, and fire it S2S to the ad's
 * pixel. The pixel was resolved + frozen at ingest (`pixelFbId`); the token is
 * resolved HERE (fresh, so a rotated token is used). Deduped by `event_id` (clickId).
 *
 * Errors: a broken/expired connection or a missing pixel is terminal → mark `failed`
 * (no point retrying). A rate-limit or transient error is rethrown so BullMQ retries
 * with backoff. Idempotent: an already-`sent` event is a no-op.
 */

export interface CapiDispatchJob {
  conversionEventId: string;
}

export interface CapiDispatchDeps {
  send: typeof sendConversionEvent;
}
const defaultDeps: CapiDispatchDeps = { send: sendConversionEvent };

async function markFailed(id: string, reason: string): Promise<void> {
  await withSystem((tx) =>
    tx.conversionEvent.update({ where: { id }, data: { status: 'failed', attempts: { increment: 1 }, fbResponse: reason } }),
  );
}

export async function dispatchConversion(
  job: CapiDispatchJob,
  deps: CapiDispatchDeps = defaultDeps,
): Promise<{ status: 'sent' | 'skipped' | 'failed' | 'missing' }> {
  const ev = await withSystem((tx) =>
    tx.conversionEvent.findUnique({ where: { id: job.conversionEventId } }),
  );
  if (!ev) return { status: 'missing' };
  if (ev.status === 'sent') return { status: 'skipped' };
  if (!ev.pixelFbId) {
    await markFailed(ev.id, 'no pixel on ad set');
    return { status: 'failed' };
  }

  // Resolve the token of the connection that owns the campaign's ad account (fresh —
  // handles rotation since ingest; a buyer may have several connected profiles).
  const campaign = await withSystem((tx) => tx.campaign.findUnique({ where: { id: ev.campaignId }, select: { adAccountId: true } }));
  const acc = campaign?.adAccountId
    ? await withSystem((tx) =>
        tx.fbAdAccount.findUnique({ where: { id: campaign.adAccountId! }, select: { connection: { select: { accessTokenEnc: true, status: true } } } }),
      )
    : null;
  const conn = acc?.connection ?? null;
  if (!conn || conn.status === FbConnectionStatus.CONNECTION_BROKEN) {
    await markFailed(ev.id, 'no usable Facebook connection');
    return { status: 'failed' };
  }

  const event: CapiEvent = {
    event_name: ev.eventName,
    event_time: Math.floor(ev.eventTime.getTime() / 1000),
    event_id: ev.clickId,
    action_source: 'website',
    ...(ev.eventSourceUrl ? { event_source_url: ev.eventSourceUrl } : {}),
    user_data: {
      ...(buildFbc(ev.fbclid, ev.eventTime.getTime()) ? { fbc: buildFbc(ev.fbclid, ev.eventTime.getTime()) } : {}),
      ...(ev.clientIp ? { client_ip_address: ev.clientIp } : {}),
      ...(ev.clientUa ? { client_user_agent: ev.clientUa } : {}),
    },
    ...(ev.valueMinor != null ? { custom_data: { value: ev.valueMinor / 100, currency: ev.currency } } : {}),
  };

  try {
    const result = await deps.send({ pixelId: ev.pixelFbId, accessToken: decryptToken(conn.accessTokenEnc), event });
    await withSystem((tx) =>
      tx.conversionEvent.update({
        where: { id: ev.id },
        data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, fbResponse: `events_received=${result.events_received ?? 0}` },
      }),
    );
    return { status: 'sent' };
  } catch (err) {
    if (err instanceof FbConnectionBrokenError) {
      await markFailed(ev.id, 'connection broken (190)');
      return { status: 'failed' };
    }
    // Rate-limit / transient → bump attempts and rethrow so BullMQ retries.
    await withSystem((tx) => tx.conversionEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 } } }));
    if (err instanceof FbRateLimitError) throw err;
    throw err;
  }
}
