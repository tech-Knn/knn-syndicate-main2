import type { FastifyInstance } from 'fastify';
import { recordTermSignal, type TermSignal } from './term-telemetry.service.js';

const SIGNALS = new Set<string>(['render', 'click']);

/**
 * Public per-term RSOC telemetry beacon. The /search page fires
 * `navigator.sendBeacon('/api/telemetry/term?term=<q>&event=render&filled=1|0')` when Google's ad
 * unit resolves for a related-search term, and `…&event=click` when an ad is clicked. Unauthenticated
 * by design (a tracking pixel); observe-only (increments a per-term/day counter); always answers 204
 * so it never leaks whether it "worked". Self-dormant — if the article app has no telemetry URL
 * configured, nothing ever calls this. Mounted at `/api/telemetry`.
 */
export async function termTelemetryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/term', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const event = (q.event ?? '').toLowerCase();
      if (!SIGNALS.has(event) || !q.term) return reply.code(204).send();
      await recordTermSignal({
        term: q.term,
        event: event as TermSignal,
        filled: q.filled === '1' || q.filled === 'true',
      });
    } catch (err) {
      req.log.error({ err }, 'term telemetry beacon failed');
    }
    return reply.code(204).send();
  });
}
