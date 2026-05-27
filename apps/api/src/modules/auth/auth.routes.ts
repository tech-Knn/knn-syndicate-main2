import type { FastifyInstance } from 'fastify';
import { handleRouteError } from '../../lib/http.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loginSchema, refreshSchema, signupSchema } from './auth.schemas.js';
import { getMe, login, logout, refresh, signup } from './auth.service.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/signup', async (req, reply) => {
    try {
      const result = await signup(signupSchema.parse(req.body));
      return reply.code(201).send(result);
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post('/login', async (req, reply) => {
    try {
      const { tokens, user } = await login(loginSchema.parse(req.body));
      return reply.send({ ...tokens, user });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post('/refresh', async (req, reply) => {
    try {
      const { refreshToken } = refreshSchema.parse(req.body);
      const { tokens, user } = await refresh(refreshToken);
      return reply.send({ ...tokens, user });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.post('/logout', async (req, reply) => {
    try {
      const { refreshToken } = refreshSchema.parse(req.body);
      await logout(refreshToken);
      return reply.code(204).send();
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  app.get('/me', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    const user = await getMe(req.auth.userId);
    if (!user) return reply.code(404).send({ error: 'User not found' });
    return reply.send({ user });
  });
}
