import type { FastifyInstance } from 'fastify';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import {
  type CreateDomainInput,
  createDomain,
  deleteDomain,
  dnsGuidance,
  listDomains,
  syncDomainChannels,
  updateDomain,
  verifyDomain,
} from './domains.service.js';

const superOnly = [authenticate, requireRole(ROLES.SUPER_ADMIN)];

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
}
