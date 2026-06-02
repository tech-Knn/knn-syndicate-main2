import type { FastifyInstance } from 'fastify';
import { type CloakRoute, type CloakVerify, recordCloakSignal } from './cloak-telemetry.service.js';

const ROUTES = new Set<string>(['money', 'white']);
const VERIFY = new Set<string>(['match', 'mismatch', 'missing', 'na']);

/**
 * Public cloaker-decision beacon. The edge redirect fires (fire-and-forget, never blocking the 302):
 *   /api/telemetry/cloak?cid=<campaignId>&route=money|white&v=match|mismatch|missing|na
 * so we can watch the money-vs-white split (and, before enforcing, the macro-hit rate) per campaign.
 * Unauthenticated by design (a tracking beacon); observe-only; always answers 204. Self-dormant —
 * if the Worker has no telemetry URL configured, nothing ever calls this. Mounted at `/api/telemetry`.
 */
export async function cloakTelemetryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/cloak', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const route = (q.route ?? '').toLowerCase();
      const verify = (q.v ?? 'na').toLowerCase();
      if (q.cid && ROUTES.has(route) && VERIFY.has(verify)) {
        await recordCloakSignal({ campaignId: q.cid, route: route as CloakRoute, verify: verify as CloakVerify });
      }
    } catch (err) {
      req.log.error({ err }, 'cloak telemetry beacon failed');
    }
    return reply.code(204).send();
  });
}
