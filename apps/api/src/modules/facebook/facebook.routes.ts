import type { FastifyInstance } from 'fastify';
import { env } from '@knn/config';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import {
  checkLaunchAccess,
  disconnect,
  getAuthUrl,
  getFbAccess,
  handleCallback,
  listAccountPages,
  listAccounts,
  listAllProfiles,
  listFbAccessRequests,
  listPages,
  listPixels,
  listProfileAccounts,
  listProfilePages,
  listProfiles,
  markFbAccessInvited,
  requestFbAccess,
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
  // `?app=launch` connects the optional short-lived LAUNCH app; default is the DATA app.
  app.get<{ Querystring: { app?: string } }>('/auth-url', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      const appKind = req.query.app === 'launch' ? 'LAUNCH' : 'DATA';
      return reply.send(await getAuthUrl(req.auth, appKind));
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

  // The actor's own connected profiles.
  app.get('/profiles', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ profiles: await listProfiles(req.auth) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Platform oversight: every connected profile across all users (super-admin only).
  app.get('/profiles/all', { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ profiles: await listAllProfiles() });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // ── Tester onboarding (apps in Dev mode) ─────────────────────────────────────────────────────
  // Buyer's own onboarding state (drives the in-product checklist).
  app.get('/access', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await getFbAccess(req.auth));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
  // Buyer submits their Facebook profile URL/username → REQUESTED.
  app.post<{ Body: { fbHandle?: string } }>('/access', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await requestFbAccess(req.auth, String(req.body?.fbHandle ?? '')));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
  // Super-admin: the queue of buyers awaiting tester access + dashboard deep-links to add them.
  app.get('/access/requests', { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await listFbAccessRequests());
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
  // Super-admin: mark a buyer as added in the FB dashboard → INVITED.
  app.post<{ Params: { userId: string } }>('/access/requests/:userId/invited', { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      await markFbAccessInvited(req.params.userId);
      return reply.send({ ok: true });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Re-sync one profile's accounts/pages/pixels from Facebook.
  app.post<{ Params: { id: string } }>('/profiles/:id/sync', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await resync(req.auth, req.params.id));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Asset-coverage check for a launch-app connection: does its short-lived token see all
  // the same person's DATA assets? (So clone/relaunch won't hit a "different account" error.)
  app.get<{ Params: { id: string } }>('/profiles/:id/launch-access', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await checkLaunchAccess(req.auth, req.params.id));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Disconnect one profile.
  app.delete<{ Params: { id: string } }>('/profiles/:id', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      await disconnect(req.auth, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // A profile's ad accounts / pages (the Facebook-tab drill-down).
  app.get<{ Params: { id: string } }>('/profiles/:id/accounts', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ accounts: await listProfileAccounts(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/profiles/:id/pages', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ pages: await listProfilePages(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Aggregated assets across all the actor's profiles — feeds the campaign launcher.
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

  app.get<{ Params: { id: string } }>('/accounts/:id/pixels', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ pixels: await listPixels(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Pages promotable by a specific ad account (scopes the wizard's page picker).
  app.get<{ Params: { id: string } }>('/accounts/:id/pages', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ pages: await listAccountPages(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
}
