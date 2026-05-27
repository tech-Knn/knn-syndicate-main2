import type { preHandlerHookHandler } from 'fastify';
import type { Role, UserStatus } from '@knn/shared';
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
  try {
    const claims = await verifyAccessToken(header.slice('Bearer '.length));
    req.auth = {
      userId: claims.sub,
      orgId: claims.org,
      role: claims.role,
      status: claims.status,
    };
  } catch {
    await reply.code(401).send({ error: 'Invalid or expired token' });
  }
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
