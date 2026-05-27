import type { FastifyInstance } from 'fastify';
import { ROLES } from '@knn/shared';
import { handleRouteError } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/authenticate.js';
import { createOrgSchema, userActionSchema } from './admin.schemas.js';
import { createOrganization, listUsers, setUserStatus } from './admin.service.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/organizations',
    { preHandler: [authenticate, requireRole(ROLES.SUPER_ADMIN)] },
    async (req, reply) => {
      try {
        const result = await createOrganization(createOrgSchema.parse(req.body));
        return reply.code(201).send(result);
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
}
