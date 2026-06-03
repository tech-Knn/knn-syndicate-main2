import type { FastifyInstance } from 'fastify';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import {
  getBuyerRollup,
  getCampaignBreakdown,
  getCampaignDimBreakdown,
  getCampaignOfferStats,
  getCampaignPerformance,
  getCompanyRollup,
  getSummary,
  getSyncStatus,
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

  // Freshness of the scheduled syncs (no manual refresh — see getSyncStatus). Drives the
  // Analytics "auto-updates • last updated X ago" indicator.
  app.get('/sync-status', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send(await getSyncStatus(req.auth));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

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

  // Per-offer revenue for one campaign (Phase F) — owner/admin scoped in the service.
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/campaigns/:id/offers',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ offers: await getCampaignOfferStats(req.auth, req.params.id, parseRange(req.query)) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Per-dimension (country / hour) breakdown for one campaign — owner/admin scoped.
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; dim?: string } }>(
    '/campaigns/:id/dim',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const dim = req.query.dim === 'hour' ? 'hour' : 'country';
        return reply.send({ rows: await getCampaignDimBreakdown(req.auth, req.params.id, parseRange(req.query), dim) });
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
