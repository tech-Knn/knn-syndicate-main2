import type { FastifyInstance } from 'fastify';
import { env } from '@knn/config';
import { handleRouteError } from '../../lib/http.js';
import { authenticate } from '../../middleware/authenticate.js';
import {
  disconnect,
  getAuthUrl,
  getConnectionStatus,
  handleCallback,
  listAccountPages,
  listAccounts,
  listPages,
  listPixels,
  resync,
} from './facebook.service.js';

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export async function facebookRoutes(app: FastifyInstance): Promise<void> {
  // Start the OAuth flow — returns the Facebook dialog URL to open in the browser.
  app.get('/auth-url', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await getAuthUrl(req.auth));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // PUBLIC: Facebook redirects the browser here with ?code & ?state. We finish
  // the exchange server-side, then bounce the user back to the dashboard.
  app.get<{ Querystring: CallbackQuery }>('/callback', async (req, reply) => {
    const dest = `${env.WEB_DOMAIN}/dashboard/facebook`;
    const { code, state, error } = req.query;
    if (error || !code || !state) {
      const reason = error ?? 'missing_code';
      return reply.redirect(`${dest}?fb_error=${encodeURIComponent(reason)}`);
    }
    try {
      await handleCallback(code, state);
      return reply.redirect(`${dest}?fb_connected=1`);
    } catch (err) {
      req.log.error({ err }, 'facebook oauth callback failed');
      return reply.redirect(`${dest}?fb_error=connect_failed`);
    }
  });

  app.get('/status', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send(await getConnectionStatus(req.auth));
  });

  app.get('/accounts', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ accounts: await listAccounts(req.auth) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.get('/pages', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ pages: await listPages(req.auth) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>(
    '/accounts/:id/pixels',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ pixels: await listPixels(req.auth, req.params.id) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Pages promotable by a specific ad account (scopes the wizard's page picker).
  app.get<{ Params: { id: string } }>(
    '/accounts/:id/pages',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ pages: await listAccountPages(req.auth, req.params.id) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.post('/sync', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await resync(req.auth));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.delete('/connection', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      await disconnect(req.auth);
      return reply.code(204).send();
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
}
