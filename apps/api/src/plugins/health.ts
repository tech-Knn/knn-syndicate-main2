import type { FastifyInstance } from 'fastify';
import { env, rootVersion } from '@knn/config';
import { prisma } from '@knn/db';
import { pingRedis } from '@knn/queue';

type Health = 'up' | 'down';

/** Liveness (`/health/live`) + readiness (`/health`, checks DB + Redis). */
export async function registerHealth(app: FastifyInstance): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health', async (_req, reply) => {
    const checks: { db: Health; redis: Health } = { db: 'down', redis: 'down' };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = 'up';
    } catch (err) {
      app.log.error({ err }, 'health: database check failed');
    }

    try {
      if (await pingRedis()) checks.redis = 'up';
    } catch (err) {
      app.log.error({ err }, 'health: redis check failed');
    }

    const ok = checks.db === 'up' && checks.redis === 'up';
    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      version: rootVersion(),
      env: env.APP_ENV,
      checks,
    };
  });
}
