import type { FastifyInstance } from 'fastify';
import { env } from '@knn/config';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import {
  disconnect,
  disconnectAccount,
  getAuthUrl,
  getStatus,
  handleCallback,
  listAfsAccounts,
  previewAccountRevenue,
  setAccountLabel,
  syncChannelCatalog,
  syncChannels,
  triggerAttribution,
} from './adsense.service.js';

const superOnly = [authenticate, requireRole(ROLES.SUPER_ADMIN)];

/**
 * Platform AdSense (Google) connect. All management routes are SUPER_ADMIN-only
 * (AdSense is a single platform account). The OAuth callback is public — it round-trips
 * through Google and verifies the signed `state` itself.
 */
export async function adsenseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth-url', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await getAuthUrl(req.auth));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.get('/status', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send(await getStatus());
  });

  // All connected AFS accounts (multi-account, Phase B).
  app.get('/accounts', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send({ accounts: await listAfsAccounts() });
  });

  app.patch<{ Params: { id: string }; Body: { label?: string } }>(
    '/accounts/:id',
    { preHandler: superOnly },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const label = (req.body?.label ?? '').trim();
        if (!label) return reply.code(400).send({ error: 'Label required' });
        return reply.send({ account: await setAccountLabel(req.auth, req.params.id, label) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/accounts/:id', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      await disconnectAccount(req.auth, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Sync the account's full ~100k channel list into the local catalog (instant browse).
  app.post<{ Params: { id: string } }>('/accounts/:id/catalog/sync', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await syncChannelCatalog(req.auth, req.params.id));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Live AFS revenue preview for one account over a date range (top-earning channels +
  // pool-mapping check). Read-only — proves the live pull + the CUSTOM_CHANNEL_ID ↔ `ch` mapping.
  app.get<{ Params: { id: string }; Querystring: { since?: string; until?: string } }>(
    '/accounts/:id/report',
    { preHandler: superOnly },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      const { since, until } = req.query;
      const isDay = (s?: string): boolean => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));
      if (!isDay(since) || !isDay(until)) return reply.code(400).send({ error: 'since & until (YYYY-MM-DD) required' });
      try {
        return reply.send(await previewAccountRevenue(req.params.id, since!, until!));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Enqueue an on-demand attribution run (pull FB + AdSense, re-allocate) so revenue lands now.
  app.post('/attribution/run', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await triggerAttribution(req.auth));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Body: { ranges?: string } }>('/sync', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await syncChannels(req.auth, req.body?.ranges));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.delete('/connection', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      await disconnect(req.auth);
      return reply.code(204).send();
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Public OAuth callback — verifies the signed state, then 302s back to the dashboard.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;
      if (error || !code || !state) {
        return reply.redirect(`${env.WEB_DOMAIN}/dashboard/platform?adsense_error=${error ?? 'missing_code'}`);
      }
      const dest = await handleCallback(code, state);
      return reply.redirect(dest);
    },
  );
}
