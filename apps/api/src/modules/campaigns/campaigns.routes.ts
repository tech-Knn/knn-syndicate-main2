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
import { launchCampaign, setCampaignActive, testLaunchCampaign } from './launch.service.js';
import { listArticleVariants, listOfferDomains, listOffers, setOffers } from './offers.service.js';
import { offerSetSchema } from './offers.schemas.js';

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

  // LIVE domains a buyer can attach as offers (Phase E). Static path → before `/:id`.
  app.get('/offer-domains', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send({ domains: await listOfferDomains(req.auth) });
  });

  // READY articles in the org — options for an offer's article-variant (A/B) picker.
  app.get('/article-variants', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send({ articles: await listArticleVariants(req.auth) });
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

  // Optimization actions: pause / resume a launched campaign (flips FB delivery + local status).
  app.post<{ Params: { id: string } }>('/:id/pause', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ campaign: await setCampaignActive(req.auth, req.params.id, false) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/:id/resume', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ campaign: await setCampaignActive(req.auth, req.params.id, true) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

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

  // Campaign offers (Phase E): the websites a campaign's traffic routes across, each
  // with a weight + kind. Owner/admin scoped in the service; editable pre-approval.
  app.get<{ Params: { id: string } }>('/:id/offers', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ offers: await listOffers(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.put<{ Params: { id: string } }>('/:id/offers', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      const { offers } = offerSetSchema.parse(req.body);
      return reply.send({ offers: await setOffers(req.auth, req.params.id, offers) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

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

  // Real launch (Phase 8): article → KV redirect sync → create on FB ACTIVE → ACTIVE.
  // Requires the campaign to already have a channel (assigned post-approval, Phase 6).
  // Any authenticated user — a MEDIA_BUYER may manually launch THEIR OWN approved
  // campaign (the service owner-scopes via buyerId); admins launch any in their org.
  // Approval stays admin-only (see /approve below) — launch ≠ approval.
  app.post<{ Params: { id: string } }>(
    '/:id/launch',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send(await launchCampaign(req.auth, req.params.id));
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
