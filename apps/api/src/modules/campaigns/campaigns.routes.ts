import type { FastifyInstance } from 'fastify';
import { ROLES, campaignDraftSchema } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { generateArticleForCampaign } from '../articles/articles.service.js';
import { approveCampaign, listPendingApprovals, rejectCampaign } from './approval.service.js';
import { rejectCampaignSchema } from './approval.schemas.js';
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  reopenCampaign,
  submitCampaign,
  updateCampaign,
} from './campaigns.service.js';
import { testLaunchCampaign } from './launch.service.js';

const adminOnly = [authenticate, requireRole(ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN)];

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send({ campaigns: await listCampaigns(req.auth) });
  });

  // Admin review queue. Registered before `/:id` (static routes take precedence
  // in Fastify, but keep it ahead for clarity).
  app.get('/pending', { preHandler: adminOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send({ campaigns: await listPendingApprovals(req.auth) });
  });

  app.post('/', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      const campaign = await createCampaign(req.auth, campaignDraftSchema.parse(req.body));
      return reply.code(201).send({ campaign });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/:id', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ campaign: await getCampaign(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const campaign = await updateCampaign(req.auth, req.params.id, campaignDraftSchema.parse(req.body));
        return reply.send({ campaign });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/:id/submit',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ campaign: await submitCampaign(req.auth, req.params.id) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Buyer withdraws a pending submission / revises a rejected one back to DRAFT.
  app.post<{ Params: { id: string } }>(
    '/:id/reopen',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ campaign: await reopenCampaign(req.auth, req.params.id) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/:id/approve',
    { preHandler: adminOnly },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ campaign: await approveCampaign(req.auth, req.params.id) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/:id/reject',
    { preHandler: adminOnly },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const { reason } = rejectCampaignSchema.parse(req.body);
        return reply.send({ campaign: await rejectCampaign(req.auth, req.params.id, reason) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        await deleteCampaign(req.auth, req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Generate (or reuse) + attach the campaign's monetized article (Phase 5, D16).
  // Owner/admin scoped in the service. Normally driven by the post-approval pipeline
  // (Phase 6/8); exposed here for manual trigger + regeneration.
  app.post<{ Params: { id: string } }>(
    '/:id/article',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ article: await generateArticleForCampaign(req.auth, req.params.id) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Stopgap (B): push a built campaign to Facebook in PAUSED state to validate the
  // write-path. The real launch pipeline is Phase 8 (after approval/article/channel/redirect).
  app.post<{ Params: { id: string } }>(
    '/:id/test-launch',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send(await testLaunchCampaign(req.auth, req.params.id));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );
}
