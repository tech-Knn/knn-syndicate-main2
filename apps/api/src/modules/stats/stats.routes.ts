import type { FastifyInstance } from 'fastify';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import {
  getBuyerRollup,
  getCampaignBreakdown,
  getCampaignPerformance,
  getCompanyRollup,
  getSummary,
  parseRange,
} from './stats.service.js';

/**
 * Dashboard read API (Phase 10). All routes are authed and role-scoped in the
 * service (`runScoped`): a MEDIA_BUYER sees only their own campaigns; a
 * COMPANY_ADMIN sees their org (RLS); a SUPER_ADMIN sees the whole platform.
 * Range comes from `?from&to` (IST business days), defaulting to the last 7 days.
 */
export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/summary',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send(await getSummary(req.auth, parseRange(req.query)));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/campaigns',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ campaigns: await getCampaignPerformance(req.auth, parseRange(req.query)) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/campaigns/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send(await getCampaignBreakdown(req.auth, req.params.id, parseRange(req.query)));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Per-buyer rollup — admins (own org) + super (all buyers).
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/by-buyer',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ buyers: await getBuyerRollup(req.auth, parseRange(req.query)) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Per-company rollup — super-admin only.
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/by-company',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ companies: await getCompanyRollup(req.auth, parseRange(req.query)) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );
}
