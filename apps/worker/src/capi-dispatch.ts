import { createHash } from 'node:crypto';
import { FbConnectionStatus, withSystem } from '@knn/db';
import {
  type CapiEvent,
  FbApiError,
  FbConnectionBrokenError,
  FbPermissionDeniedError,
  FbRateLimitError,
  decryptToken,
  sendConversionEvent,
} from '@knn/fb';
import { buildFbc } from '@knn/shared';

/** SHA-256 hex — required format for CAPI `external_id` (Facebook silently discards
 *  unhashed values). */
function sha256Hex(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

/**
 * Serialize an error into a compact debuggable string for `conversion_events.fb_response`.
 * Includes FB `code`/`subcode`/`fbtrace_id` when the error is a classified `FbApiError`, so
 * operators can grep pending rows for permission failures (200/10) vs bad user data (2804),
 * etc. Non-FB errors fall back to `.message`. Truncated to keep the column small.
 */
function formatFbError(err: unknown): string {
  if (err instanceof FbApiError) {
    const parts = [
      err.code != null ? `code=${err.code}` : null,
      err.subcode != null ? `subcode=${err.subcode}` : null,
      err.httpStatus != null ? `http=${err.httpStatus}` : null,
      err.fbtraceId ? `fbtrace=${err.fbtraceId}` : null,
      `msg=${err.message}`,
    ].filter(Boolean);
    return parts.join(' ').slice(0, 500);
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

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

  // `fbc` MUST carry the FB-ad-click time (when Facebook issued the fbclid), NOT the
  // conversion time — Facebook rejects the attribution otherwise. Prefer the click time
  // captured at the edge (stored on the row at ingest); fall back to `eventTime` only for
  // legacy rows written before the fix (they'd already be miscounted; the fallback keeps
  // them from becoming worse).
  const fbcTimeMs = ev.clickTimeMs != null ? Number(ev.clickTimeMs) : ev.eventTime.getTime();
  const fbc = buildFbc(ev.fbclid, fbcTimeMs);
  const event: CapiEvent = {
    event_name: ev.eventName,
    event_time: Math.floor(ev.eventTime.getTime() / 1000),
    event_id: ev.clickId,
    action_source: 'website',
    ...(ev.eventSourceUrl ? { event_source_url: ev.eventSourceUrl } : {}),
    user_data: {
      ...(fbc ? { fbc } : {}),
      ...(ev.fbp ? { fbp: ev.fbp } : {}),
      // Stable per-visitor id (the click id), SHA-256 hashed as CAPI requires. Cheap EMQ
      // lift for pure-S2S anonymous traffic where we can't send email/phone.
      external_id: sha256Hex(ev.clickId),
      ...(ev.clientIp ? { client_ip_address: ev.clientIp } : {}),
      ...(ev.clientUa ? { client_user_agent: ev.clientUa } : {}),
    },
    ...(ev.valueMinor != null ? { custom_data: { value: ev.valueMinor / 100, currency: ev.currency } } : {}),
  };

  try {
    const result = await deps.send({ pixelId: ev.pixelFbId, accessToken: decryptToken(conn.accessTokenEnc), event });
    const fbResponse = [
      `events_received=${result.events_received ?? 0}`,
      result.fbtrace_id ? `fbtrace=${result.fbtrace_id}` : null,
      result.messages && (result.messages as unknown[]).length ? `messages=${JSON.stringify(result.messages).slice(0, 300)}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    await withSystem((tx) =>
      tx.conversionEvent.update({
        where: { id: ev.id },
        data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, fbResponse },
      }),
    );
    return { status: 'sent' };
  } catch (err) {
    if (err instanceof FbConnectionBrokenError) {
      await markFailed(ev.id, `connection broken: ${formatFbError(err)}`);
      return { status: 'failed' };
    }
    // Object-permission denial (code 100 subcode 33) is terminal — the token is fine but
    // is not authorized for this pixel/account. Retrying cannot restore a permission grant,
    // and each retry counts as another failed Marketing API call against the app-wide
    // error-rate quota (Meta trips the app into "Feature Unavailable" and rejects Marketing
    // API Access Tier once the rate exceeds ~15%). Fail fast, don't retry.
    if (err instanceof FbPermissionDeniedError) {
      await markFailed(ev.id, `permission denied: ${formatFbError(err)}`);
      return { status: 'failed' };
    }
    // Rate-limit / transient → stamp the FB error so pending rows are debuggable, bump
    // attempts, then rethrow so BullMQ retries with backoff. On the next attempt this
    // fb_response is overwritten (that's what we want — always shows the LATEST failure).
    await withSystem((tx) =>
      tx.conversionEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 }, fbResponse: formatFbError(err) } }),
    );
    if (err instanceof FbRateLimitError) throw err;
    throw err;
  }
}
