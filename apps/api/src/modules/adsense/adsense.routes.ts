import type { FastifyInstance } from 'fastify';
import { env } from '@knn/config';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { disconnect, getAuthUrl, getStatus, handleCallback, syncChannels } from './adsense.service.js';

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

  app.post('/sync', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await syncChannels(req.auth));
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
