import type { FastifyInstance } from 'fastify';
import { campaignDraftSchema } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate } from '../../middleware/authenticate.js';
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  submitCampaign,
  updateCampaign,
} from './campaigns.service.js';
import { testLaunchCampaign } from './launch.service.js';

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send({ campaigns: await listCampaigns(req.auth) });
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
