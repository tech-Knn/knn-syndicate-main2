import type { FastifyInstance } from 'fastify';
import { recordConversion } from './events.service.js';

/** Max accepted conversion value (cents) — sanity cap on the public beacon. */
const MAX_VALUE_MINOR = 100_000; // $1,000

/**
 * Public conversion beacon (Phase: conversion tracking). The /search page fires
 * `navigator.sendBeacon('/api/events?click_id=…&value=…&currency=…&url=…')` when it
 * infers the AFS ad click. Unauthenticated by design (it's a tracking pixel) — tenancy
 * + the pixel/token are resolved server-side from the (unguessable) click id, never
 * from the caller. Always answers 204: a beacon must never leak whether it "worked".
 * Mounted at `/api/events`.
 */
export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const clickId = q.click_id || q.clickId;
      if (!clickId) return reply.code(204).send();

      const valueDollars = q.value !== undefined ? Number(q.value) : NaN;
      const valueMinor =
        Number.isFinite(valueDollars) && valueDollars > 0
          ? Math.min(Math.round(valueDollars * 100), MAX_VALUE_MINOR)
          : undefined;

      const ua = req.headers['user-agent'];
      await recordConversion({
        clickId,
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
