import type { FastifyInstance } from 'fastify';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import {
  createRedirectDomain,
  deleteRedirectDomain,
  listRedirectDomains,
  setDefaultRedirectDomain,
  verifyRedirectDomain,
} from './redirect-domains.service.js';
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
  deleteUser,
  getActingOrg,
  listAuditLog,
  listOrgUsers,
  listOrganizations,
  listUsers,
  setOrgAutoApprove,
  setOrgAutoLaunch,
  setUserStatus,
} from './admin.service.js';
import {
  getArticleUsage,
  getChannelSummary,
  getChannelUsage,
  getPlatformSettings,
  listArticles,
  listChannels,
  setOrgRevenueCut,
  updatePlatformSettings,
} from './platform.service.js';
import { getCloakStats } from '../telemetry/cloak-telemetry.service.js';
import { getTermPerformance } from '../telemetry/term-telemetry.service.js';

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

  // Members of one company (super-admin only) — emails/roles/status for the Companies page.
  app.get<{ Params: { id: string } }>(
    '/organizations/:id/users',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      return reply.send({ users: await listOrgUsers(req.params.id) });
    },
  );

  // Platform activity log (super-admin only) — recent events (user add/remove, approvals, …).
  app.get<{ Querystring: { limit?: string; actions?: string } }>(
    '/audit',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const actions = req.query.actions ? req.query.actions.split(',').filter(Boolean) : undefined;
      return reply.send({ entries: await listAuditLog({ limit, actions }) });
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

  // Permanently delete a user (super-admin only) — frees the email for re-use.
  app.delete<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send(await deleteUser(req.auth, req.params.id));
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

  // Article lineage: which campaigns/domains/channels it's live on + for what time.
  app.get<{ Params: { id: string } }>(
    '/articles/:id/usage',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const usage = await getArticleUsage(req.auth, req.params.id);
        if (!usage) return reply.code(404).send({ error: 'Article not found' });
        return reply.send({ usage });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // --- Super-admin platform surfaces (global channel pool + settings + revenue cut) ---
  // Channel usage lineage: where one channel id is used (campaign/article/domain) + time.
  app.get<{ Params: { id: string } }>(
    '/channels/:id/usage',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const usage = await getChannelUsage(req.params.id);
        if (!usage) return reply.code(404).send({ error: 'Channel not found' });
        return reply.send({ usage });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Term performance (super-admin, observe-only): per-related-search-term searches/fills/clicks
  // over an IST-day range — the term-grain "monitor partner terms" RSOC signal.
  app.get<{ Querystring: { from?: string; to?: string; limit?: string } }>(
    '/term-performance',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        return reply.send(await getTermPerformance({ from: req.query.from, to: req.query.to, limit }));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Cloaker money-vs-white split per campaign (observe-first ad-ID verification) — so any
  // revenue loss from verification is visible BEFORE enforcing.
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/cloak-stats',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send(await getCloakStats({ from: req.query.from, to: req.query.to }));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

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

  // Redirect domains (super-admin): the go.* hosts the edge Worker serves; the default is
  // what new ad creatives link to. Reachability check via /verify.
  const superOnly = { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] };

  app.get('/redirect-domains', superOnly, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ domains: await listRedirectDomains() });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Body: { host?: string; label?: string } }>('/redirect-domains', superOnly, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.code(201).send({ domain: await createRedirectDomain(req.body?.host ?? '', req.body?.label) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/redirect-domains/:id/default', superOnly, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ domain: await setDefaultRedirectDomain(req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/redirect-domains/:id/verify', superOnly, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ domain: await verifyRedirectDomain(req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>('/redirect-domains/:id', superOnly, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      await deleteRedirectDomain(req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
}
