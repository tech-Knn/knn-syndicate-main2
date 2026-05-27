import { Hono } from 'hono';
import IORedis from 'ioredis';
import { env, rootVersion } from '@knn/config';

/**
 * Public redirect engine (DECISION D3: Hono for the latency-critical hot path).
 * Intentionally lean — uses ioredis directly (no BullMQ) so the bundle stays
 * small. Phase 0 ships health + a placeholder `/go/:id`; Phase 7 implements
 * ad-traffic detection and the 302 to the article page with the AFS params.
 */
const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

async function pingRedis(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export function buildApp(): Hono {
  const app = new Hono();

  app.get('/', (c) =>
    c.json({ name: 'knn-redirect', version: rootVersion(), env: env.APP_ENV }),
  );

  app.get('/health/live', (c) => c.json({ status: 'ok' }));

  app.get('/health', async (c) => {
    const redisUp = await pingRedis();
    return c.json(
      { status: redisUp ? 'ok' : 'degraded', checks: { redis: redisUp ? 'up' : 'down' } },
      redisUp ? 200 : 503,
    );
  });

  // TODO(Phase 7): look up redirect_id, detect ad traffic, inject AFS params,
  // apply traffic split, 302 to article or fallback. Placeholder for now.
  app.get('/go/:id', (c) => c.redirect(env.ARTICLE_DOMAIN, 302));

  return app;
}

export async function closeRedis(): Promise<void> {
  if (redis.status === 'ready' || redis.status === 'connecting') {
    await redis.quit();
  } else {
    redis.disconnect();
  }
}
