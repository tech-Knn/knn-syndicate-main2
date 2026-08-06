import type { FastifyInstance } from 'fastify';
import { FUNNEL_STAGES, type FunnelStage } from '@knn/shared';
import { recordConversion } from './events.service.js';

/** Max accepted conversion value (cents) — sanity cap on the public beacon. */
const MAX_VALUE_MINOR = 100_000; // $1,000

const STAGES = new Set<string>(FUNNEL_STAGES);

/**
 * Public conversion beacon (RSOC funnel). The article funnel fires
 * `navigator.sendBeacon('/api/events?click_id=…&stage=lander|search|adclick&value=…')`
 * at each stage: `lander` (article view → ViewContent), `search` (/search reached →
 * AddToCart), `adclick` (AFS ad clicked → Search, the main event). Unauthenticated by
 * design (it's a tracking pixel) — tenancy + the pixel/token are resolved server-side
 * from the (unguessable) click id, never from the caller. Always answers 204: a beacon
 * must never leak whether it "worked". Mounted at `/api/events`.
 */
export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req, reply) => {
    // The beacon fires from `articles.*` / *.entertainmentheute.de (any registered money host),
    // which is a different origin than the API. Helmet's default `Cross-Origin-Resource-Policy:
    // same-origin` makes Chrome BLOCK the cross-origin `navigator.sendBeacon` POST (surfaces as
    // ERR_BLOCKED_BY_RESPONSE.NotSameOrigin in DevTools) even though the server returned 204.
    // Override to `cross-origin` for THIS route only — safe because the endpoint is one-way
    // (writes a conversion event, always answers 204, exposes no data), so no cross-origin
    // read of anything sensitive is possible. Same treatment as /api/telemetry/term.
    void reply.header('cross-origin-resource-policy', 'cross-origin');
    try {
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const clickId = q.click_id || q.clickId;
      if (!clickId) return reply.code(204).send();

      const rawStage = (q.stage || q.pxe || '').toLowerCase();
      const stage = STAGES.has(rawStage) ? (rawStage as FunnelStage) : undefined;

      const valueDollars = q.value !== undefined ? Number(q.value) : NaN;
      const valueMinor =
        Number.isFinite(valueDollars) && valueDollars > 0
          ? Math.min(Math.round(valueDollars * 100), MAX_VALUE_MINOR)
          : undefined;

      const ua = req.headers['user-agent'];
      await recordConversion({
        clickId,
        stage,
        valueMinor,
        currency: q.currency || q.ccy || undefined,
        url: q.url || undefined,
        clientIp: req.ip,
        clientUa: Array.isArray(ua) ? ua[0] : ua,
      });
    } catch (err) {
      // Never surface beacon errors to the client; log for diagnosis.
      req.log.error({ err }, 'conversion beacon failed');
    }
    return reply.code(204).send();
  });
}
