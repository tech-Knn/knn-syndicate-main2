import type { preHandlerHookHandler } from 'fastify';
import { withSystem } from '@knn/db';
import { type Role, USER_STATUS, type UserStatus } from '@knn/shared';
import { verifyAccessToken } from '../lib/jwt.js';

export interface AuthContext {
  userId: string;
  orgId: string;
  role: Role;
  status: UserStatus;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** preHandler: require a valid access token; populates `request.auth`. */
export const authenticate: preHandlerHookHandler = async (req, reply) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    await reply.code(401).send({ error: 'Missing bearer token' });
    return;
  }
  let sub: string;
  try {
    sub = (await verifyAccessToken(header.slice('Bearer '.length))).sub;
  } catch {
    await reply.code(401).send({ error: 'Invalid or expired token' });
    return;
  }
  // Re-check the user against the DB on EVERY request so a suspend / reject / delete / role change
  // takes effect immediately — the JWT embeds a status/role snapshot that is otherwise stale until the
  // token expires (~15 min), during which a just-suspended buyer could keep launching + spending. This
  // is a cross-org system read (auth precedes the tenant guard) → withSystem (RLS bypass). DB values
  // are authoritative (also closes role/org-change staleness). Fail-closed: missing/inactive/DB-error → 401.
  const user = await withSystem((tx) =>
    tx.user.findUnique({ where: { id: sub }, select: { status: true, role: true, orgId: true } }),
  ).catch(() => null);
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    await reply.code(401).send({ error: 'Account is not active' });
    return;
  }
  req.auth = { userId: sub, orgId: user.orgId, role: user.role as Role, status: user.status as UserStatus };
};

/** preHandler factory: require the authenticated user to hold one of `roles`. */
export function requireRole(...roles: Role[]): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.auth) {
      await reply.code(401).send({ error: 'Unauthenticated' });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      await reply.code(403).send({ error: 'Forbidden' });
    }
  };
}
