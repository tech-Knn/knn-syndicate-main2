import type { FastifyInstance } from 'fastify';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { connectSchema, metaConnectSchema, pixelCheckSchema } from './whop.schemas.js';
import {
  checkPixel,
  connect,
  createManagedPage,
  disconnect,
  getConnection,
  listAllConnections,
  listConnections,
  listPages,
  recheck,
  refreshPage,
  startMetaConnect,
  whopStatus,
} from './whop.service.js';

/**
 * Whop Ads connection routes, mounted at `/api/ad-providers/whop` (D33). Kept apart from
 * `/api/facebook/*`, which stays exactly as it is. Every route answers 404 unless Whop Ads is enabled
 * for the caller (global flag + the company switch), so the feature is invisible until turned on.
 * Ownership is enforced in the service: a user touches only their own connections; a super-admin any.
 */
export async function whopRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [authenticate] };

  // What the dashboard needs to decide whether to show Whop at all. Never 404s: "off" is an answer.
  app.get('/status', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send(await whopStatus(req.auth));
  });

  app.get('/connections', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ connections: await listConnections(req.auth) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Super-admin oversight: every connection with its owner. Declared before `/connections/:id`.
  app.get('/connections/all', { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ connections: await listAllConnections(req.auth) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post('/connections', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.code(201).send({ connection: await connect(req.auth, connectSchema.parse(req.body)) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/connections/:id', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ connection: await getConnection(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/connections/:id/check', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ connection: await recheck(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>('/connections/:id', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      await disconnect(req.auth, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/connections/:id/pages', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ pages: await listPages(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/connections/:id/pages/meta-connect', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      const { redirectUrl } = metaConnectSchema.parse(req.body);
      return reply.send(await startMetaConnect(req.auth, req.params.id, redirectUrl));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/connections/:id/pages/create', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ connection: await createManagedPage(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string; pageId: string } }>('/connections/:id/pages/:pageId/refresh', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ connection: await refreshPage(req.auth, req.params.id, req.params.pageId) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/connections/:id/pixel-check', guard, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      const { url } = pixelCheckSchema.parse(req.body ?? {});
      return reply.send({ pixel: await checkPixel(req.auth, req.params.id, url) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
}
