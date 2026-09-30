import { env } from '@knn/config';
import { WhopConnectionStatus, withSystem } from '@knn/db';
import { decryptToken } from '@knn/fb';
import { buildFbc } from '@knn/shared';
import { type WhopApi, type WhopClickFields, type WhopApiError, buildWhopEvent, createWhopClient, isWhopError, whopApi, whopEventTooOld } from '@knn/whop';
import { type WorkerNotification, sendNotification } from './lib/notify.js';

/**
 * Whop dispatch (conversion tracking, D33): the Whop sibling of `capi-dispatch.ts`. One `WHOP_DISPATCH` job
 * takes a pending `ConversionEvent` whose provider is 'whop', resolves the business's API key, and reports the
 * conversion to Whop's Events API server-to-server. The money page carries no Whop pixel (only the page Whop's
 * ad check sees does), so this is how Whop learns of a real visit, keyword click or ad click.
 *
 * The business, the landing URL and Whop's click ids were frozen on the row at ingest (`provider_context`),
 * because this job cannot read the edge KV. The key is resolved HERE, fresh, so a rotated key is used.
 *
 * Outcomes, by the error's KIND (never by message text):
 *  - sent: `provider_ref` = Whop's id, `provider_response` = ok.
 *  - auth (401): Whop rejected the key. Terminal. The connection is flipped to BROKEN once and its owner
 *    notified, so every later event skips the call instead of burning another refusal.
 *  - permission (403): the key lacks `event:create` (or belongs to another business). Terminal, and it names
 *    the permission; the connection stays ACTIVE because its other permissions may be fine.
 *  - validation / not_found / conflict / payment_required: terminal, recorded on the row.
 *  - rate_limited / server / network / timeout: transient. Recorded, then rethrown so BullMQ retries with backoff.
 * Anything BullMQ gives up on is settled by `failExhaustedWhopEvent`, so a row never sits `pending` forever.
 * Idempotent: an already-`sent` event is a no-op, and Whop keeps one copy of a repeated (name, event id).
 */

export interface WhopDispatchJob {
  conversionEventId: string;
}

export interface WhopConnectionForDispatch {
  id: string;
  orgId: string;
  userId: string;
  bizId: string;
  label: string | null;
  apiKeyEnc: string;
  environment: 'PRODUCTION' | 'SANDBOX';
  apiVersionDate: string;
}

export interface WhopDispatchDeps {
  /** The Whop API for a stored connection. Injectable so tests can point at the mock. */
  apiFor: (conn: WhopConnectionForDispatch) => WhopApi;
  notify: (n: WorkerNotification) => void;
  now: () => Date;
  /** Whop Ads is on (`WHOP_ADS_ENABLED`). */
  enabled: () => boolean;
}

const defaultDeps: WhopDispatchDeps = {
  apiFor: (conn) =>
    // BullMQ is the retry layer here, so the client only retries once on its own.
    whopApi(
      createWhopClient({
        apiKey: decryptToken(conn.apiKeyEnc),
        baseUrl: conn.environment === 'SANDBOX' ? env.WHOP_SANDBOX_API_BASE : env.WHOP_API_BASE,
        versionDate: conn.apiVersionDate,
        maxRetries: 1,
      }),
    ),
  notify: sendNotification,
  now: () => new Date(),
  enabled: () => env.WHOP_ADS_ENABLED,
};

interface WhopProviderContext {
  bizId?: string | null;
  landing?: string | null;
  click?: WhopClickFields | null;
}

type Outcome = { status: 'sent' | 'skipped' | 'failed' | 'missing' };

/** `kind status=… code=… msg=…`, for `provider_response`. Carries nothing from the request: never the key. */
function formatWhopError(err: WhopApiError): string {
  return [`${err.kind}`, `status=${err.status}`, err.code ? `code=${err.code}` : null, `msg=${err.message}`].filter(Boolean).join(' ').slice(0, 500);
}

async function settle(id: string, status: 'failed' | 'skipped', reason: string): Promise<void> {
  await withSystem((tx) => tx.conversionEvent.update({ where: { id }, data: { status, attempts: { increment: 1 }, providerResponse: reason.slice(0, 500) } }));
}

/** The connection that reports this event: the campaign buyer's own when they have one, else any live one of the company. */
async function resolveConnection(orgId: string, campaignId: string, bizId: string): Promise<WhopConnectionForDispatch | null> {
  return withSystem(async (tx) => {
    const buyer = await tx.campaign.findUnique({ where: { id: campaignId }, select: { buyerId: true } });
    const select = { id: true, orgId: true, userId: true, bizId: true, label: true, apiKeyEnc: true, environment: true, apiVersionDate: true } as const;
    const mine = buyer ? await tx.whopConnection.findFirst({ where: { orgId, bizId, userId: buyer.buyerId, status: WhopConnectionStatus.ACTIVE }, select }) : null;
    return mine ?? (await tx.whopConnection.findFirst({ where: { orgId, bizId, status: WhopConnectionStatus.ACTIVE }, orderBy: { updatedAt: 'desc' }, select }));
  });
}

export async function dispatchWhopEvent(job: WhopDispatchJob, deps: WhopDispatchDeps = defaultDeps): Promise<Outcome> {
  const ev = await withSystem((tx) => tx.conversionEvent.findUnique({ where: { id: job.conversionEventId } }));
  if (!ev) return { status: 'missing' };
  if (ev.status === 'sent') return { status: 'skipped' };
  if (ev.provider !== 'whop') {
    await settle(ev.id, 'failed', 'not a Whop event');
    return { status: 'failed' };
  }
  if (!deps.enabled()) {
    await settle(ev.id, 'skipped', 'Whop Ads is off');
    return { status: 'skipped' };
  }

  const ctx = (ev.providerContext ?? {}) as WhopProviderContext;
  if (!ctx.bizId) {
    await settle(ev.id, 'failed', 'no Whop business on the event');
    return { status: 'failed' };
  }
  // Whop refuses anything older than 28 days: sending it can never succeed, so do not try.
  if (whopEventTooOld(ev.eventTime, deps.now())) {
    await settle(ev.id, 'failed', 'older than Whop accepts (28 days)');
    return { status: 'failed' };
  }

  const conn = await resolveConnection(ev.orgId, ev.campaignId, ctx.bizId);
  if (!conn) {
    await settle(ev.id, 'failed', 'no usable Whop connection');
    return { status: 'failed' };
  }

  // `fbc` carries the ad-click time (when Facebook issued the fbclid), not the conversion time; the row stores it.
  const fbcTimeMs = ev.clickTimeMs != null ? Number(ev.clickTimeMs) : ev.eventTime.getTime();
  const input = buildWhopEvent({
    bizId: ctx.bizId,
    storedEventName: ev.eventName,
    clickId: ev.clickId,
    occurredAt: ev.eventTime,
    landingUrl: ctx.landing,
    ipAddress: ev.clientIp,
    userAgent: ev.clientUa,
    fbclid: ev.fbclid,
    fbc: buildFbc(ev.fbclid, fbcTimeMs),
    fbp: ev.fbp,
    click: ctx.click,
    valueMinor: ev.valueMinor,
    currency: ev.currency,
  });
  if (!input) {
    await settle(ev.id, 'failed', `not a funnel event: ${ev.eventName}`);
    return { status: 'failed' };
  }

  try {
    const res = await deps.apiFor(conn).createEvent(input);
    await withSystem((tx) =>
      tx.conversionEvent.update({ where: { id: ev.id }, data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, providerRef: res.id, providerResponse: 'ok' } }),
    );
    return { status: 'sent' };
  } catch (err) {
    if (!isWhopError(err)) {
      // Not a Whop answer (e.g. the stored key could not be decrypted): count it and let BullMQ retry.
      await withSystem((tx) => tx.conversionEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 }, providerResponse: (err instanceof Error ? err.message : String(err)).slice(0, 500) } }));
      throw err;
    }
    const reason = formatWhopError(err);
    switch (err.kind) {
      case 'auth': {
        // Flip the CONNECTION once, not just this event: otherwise every later event burns another refusal.
        const flipped = await withSystem((tx) =>
          tx.whopConnection.updateMany({
            where: { id: conn.id, status: WhopConnectionStatus.ACTIVE },
            data: { status: WhopConnectionStatus.BROKEN, lastError: 'Whop rejected the API key while reporting a conversion.' },
          }),
        );
        if (flipped.count > 0) {
          deps.notify({
            orgId: conn.orgId,
            userId: conn.userId,
            type: 'whop_connection_broken',
            title: 'Whop connection needs attention',
            body: `${conn.label ?? conn.bizId} (${conn.bizId}): Whop rejected the API key while reporting a conversion. Reconnect with a working key.`,
          });
        }
        await settle(ev.id, 'failed', `connection broken: ${reason}`);
        return { status: 'failed' };
      }
      case 'permission':
      case 'validation':
      case 'not_found':
      case 'conflict':
      case 'payment_required':
        await settle(ev.id, 'failed', reason);
        return { status: 'failed' };
      default:
        // rate_limited / server / network / timeout: transient. Record the latest failure, then let BullMQ retry.
        await withSystem((tx) => tx.conversionEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 }, providerResponse: reason } }));
        throw err;
    }
  }
}

/**
 * BullMQ gave up on a job (its retries are used up): settle the row so it does not sit `pending` forever.
 * A row that was sent in the meantime is left alone.
 */
export async function failExhaustedWhopEvent(conversionEventId: string, reason: string): Promise<void> {
  await withSystem((tx) =>
    tx.conversionEvent.updateMany({ where: { id: conversionEventId, provider: 'whop', status: 'pending' }, data: { status: 'failed', providerResponse: `retries exhausted: ${reason}`.slice(0, 500) } }),
  );
}
