import type { FastifyInstance } from 'fastify';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import {
  type ChannelSelection,
  type CreateDomainInput,
  createDomain,
  deleteDomain,
  dnsGuidance,
  importAllChannels,
  isDomainRegistered,
  listDomainAfsChannels,
  listDomains,
  resolveSiteConfig,
  setDomainChannels,
  syncDomainChannels,
  updateDomain,
  verifyDomain,
} from './domains.service.js';

const superOnly = [authenticate, requireRole(ROLES.SUPER_ADMIN)];

/**
 * Public, unauthenticated edge endpoint for Caddy on-demand TLS. The edge calls
 * `GET /api/public/domain-allowed?domain=<host>` during a TLS handshake for an
 * unknown SNI; a 2xx tells Caddy to mint a cert and serve the article app for
 * that host. We return 200 only for a registered Domain, so the catch-all can
 * serve any number of article domains with zero per-domain Caddy changes — while
 * refusing certs for arbitrary hosts pointed at the box. Mounted at `/api/public`.
 */
export async function publicEdgeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { domain?: string } }>('/domain-allowed', async (req, reply) => {
    const host = req.query.domain;
    if (!host) return reply.code(400).send({ allowed: false, error: 'Missing domain' });
    try {
      if (!(await isDomainRegistered(host))) return reply.code(404).send({ allowed: false });
      return reply.send({ allowed: true });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // Per-host AFS config for the article SSR (Phase D). Lets one article app serve
  // many websites, each rendering under its OWN AFS account's pubId. 404 → the
  // article app uses its build-time env defaults. Cacheable (config changes rarely).
  app.get<{ Querystring: { host?: string } }>('/site-config', async (req, reply) => {
    const host = req.query.host;
    if (!host) return reply.code(400).send({ error: 'Missing host' });
    try {
      const cfg = await resolveSiteConfig(host);
      if (!cfg) return reply.code(404).send({ error: 'Host not registered' });
      void reply.header('cache-control', 'public, max-age=300');
      return reply.send(cfg);
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
}

/** Super-admin domain (website) management — Phase C. */
export async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    return reply.send({ domains: await listDomains(), dns: dnsGuidance() });
  });

  app.post<{ Body: CreateDomainInput }>('/', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.code(201).send({ domain: await createDomain(req.auth, req.body) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.patch<{ Params: { id: string }; Body: Partial<CreateDomainInput> }>(
    '/:id',
    { preHandler: superOnly },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send({ domain: await updateDomain(req.auth, req.params.id, req.body) });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      await deleteDomain(req.auth, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/:id/verify', { preHandler: superOnly }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      return reply.send({ domain: await verifyDomain(req.auth, req.params.id) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: { ranges?: string } }>(
    '/:id/sync',
    { preHandler: superOnly },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        return reply.send(await syncDomainChannels(req.auth, req.params.id, req.body?.ranges));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Browse the domain's AFS account custom channels by name/id (pick which to use).
  app.get<{ Params: { id: string }; Querystring: { q?: string; range?: string; limit?: string } }>(
    '/:id/afs-channels',
    { preHandler: superOnly },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        return reply.send(await listDomainAfsChannels(req.auth, req.params.id, { q: req.query.q, range: req.query.range, limit }));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );

  // Import / remove selected channels (label = the AFS name), or `importAll` to pull
  // every channel the API returns (optionally filtered by `q`) — no ticking.
  app.post<{ Params: { id: string }; Body: ChannelSelection & { importAll?: boolean; q?: string; range?: string } }>(
    '/:id/afs-channels',
    { preHandler: superOnly },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
      try {
        if (req.body?.importAll) {
          return reply.send(await importAllChannels(req.auth, req.params.id, { q: req.body.q, range: req.body.range }));
        }
        return reply.send(await setDomainChannels(req.auth, req.params.id, req.body ?? {}));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    },
  );
}
