import type { FastifyInstance } from 'fastify';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import {
  addOrgUserSchema,
  autoApproveSchema,
  autoLaunchSchema,
  createOrgSchema,
  platformSettingsSchema,
  revenueCutSchema,
  userActionSchema,
} from './admin.schemas.js';
import {
  addOrgUser,
  createOrganization,
  getActingOrg,
  listOrganizations,
  listUsers,
  setOrgAutoApprove,
  setOrgAutoLaunch,
  setUserStatus,
} from './admin.service.js';
import {
  getChannelSummary,
  getPlatformSettings,
  listArticles,
  listChannels,
  setOrgRevenueCut,
  updatePlatformSettings,
} from './platform.service.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/organizations',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const result = await createOrganization(req.auth, createOrgSchema.parse(req.body));
        return reply.code(201).send(result);
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // All companies (super-admin only) — list + counts for the Companies management page.
  app.get(
    '/organizations',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      return reply.send({ organizations: await listOrganizations() });
    },
  );

  // Add an admin/buyer to an existing company (super-admin only).
  app.post<{ Params: { id: string } }>(
    '/organizations/:id/users',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.code(201).send({ user: await addOrgUser(req.auth, req.params.id, addOrgUserSchema.parse(req.body)) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.get(
    '/organization',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ organization: await getActingOrg(req.auth) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/organizations/:id/auto-approve',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const { autoApprove } = autoApproveSchema.parse(req.body);
        const org = await setOrgAutoApprove(req.auth, req.params.id, autoApprove);
        return reply.send({ organization: org });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/organizations/:id/auto-launch',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const { autoLaunch } = autoLaunchSchema.parse(req.body);
        const org = await setOrgAutoLaunch(req.auth, req.params.id, autoLaunch);
        return reply.send({ organization: org });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.get(
    '/users',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      return reply.send({ users: await listUsers(req.auth) });
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const { action } = userActionSchema.parse(req.body);
        const user = await setUserStatus(req.auth, req.params.id, action);
        return reply.send({ user });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Articles list — super (all) + company-admin (own org).
  app.get(
    '/articles',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ articles: await listArticles(req.auth) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // --- Super-admin platform surfaces (global channel pool + settings + revenue cut) ---
  app.get(
    '/channels',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ channels: await listChannels() });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Accurate pool counts (totals + per-website) — replaces the capped raw list in the UI.
  app.get(
    '/channel-summary',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send(await getChannelSummary());
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.get(
    '/settings',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ settings: await getPlatformSettings() });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.patch(
    '/settings',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const settings = await updatePlatformSettings(req.auth, platformSettingsSchema.parse(req.body));
        return reply.send({ settings });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/organizations/:id/revenue-cut',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const { pct } = revenueCutSchema.parse(req.body);
        return reply.send({ organization: await setOrgRevenueCut(req.auth, req.params.id, pct) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );
}
