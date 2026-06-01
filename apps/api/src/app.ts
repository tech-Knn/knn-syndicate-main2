import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit, { type RateLimitPluginOptions } from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { Redis } from 'ioredis';
import { createConnection } from '@knn/queue';
import { env, rootVersion } from '@knn/config';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { adsenseRoutes } from './modules/adsense/adsense.routes.js';
import { publicArticleRoutes } from './modules/articles/articles.routes.js';
import { domainRoutes, publicEdgeRoutes } from './modules/domains/domains.routes.js';
import { internalRoutes } from './modules/internal/internal.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { campaignRoutes } from './modules/campaigns/campaigns.routes.js';
import { eventsRoutes } from './modules/events/events.routes.js';
import { facebookRoutes } from './modules/facebook/facebook.routes.js';
import { statsRoutes } from './modules/stats/stats.routes.js';
import { termTelemetryRoutes } from './modules/telemetry/term-telemetry.routes.js';
import { uploadRoutes } from './modules/uploads/uploads.routes.js';
import { registerBullBoard } from './plugins/bull-board.js';
import { registerHealth } from './plugins/health.js';

function loggerOptions(): FastifyServerOptions['logger'] {
  if (env.APP_ENV === 'local') {
    return {
      level: env.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: env.LOG_LEVEL };
}

/** Paths exempt from rate limiting: infra/edge callers (Caddy on-demand-TLS ask + the
 *  article SSR site-config, the worker's internal launch, health, Bull-Board). */
export function isRateLimitExempt(req: FastifyRequest): boolean {
  const path = req.url.split('?')[0] ?? '';
  return (
    path === '/' ||
    path.startsWith('/health') ||
    path.startsWith('/admin/queues') ||
    path.startsWith('/api/public') ||
    path.startsWith('/api/internal')
  );
}

/**
 * Global rate-limit config (Phase 11). `skipOnError` fails OPEN — a Redis blip never
 * takes the API down. With no `redis` (tests) it uses the in-memory store. Sensitive
 * auth routes tighten the cap per-route (see auth.routes.ts).
 */
export function rateLimitOptions(redis?: Redis): RateLimitPluginOptions {
  return {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    ...(redis ? { redis } : {}),
    nameSpace: 'knn-rl:',
    skipOnError: true,
    allowList: (req) => isRateLimitExempt(req),
  };
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(),
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: [env.WEB_DOMAIN], credentials: true });
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });

  // Per-IP rate limiting (Phase 11), Redis-backed so it's shared across API replicas.
  // Skipped under `test` so the integration suite (many logins from one IP) isn't
  // throttled; the behaviour itself is covered by rate-limit.test.ts.
  if (env.NODE_ENV !== 'test') {
    await app.register(rateLimit, rateLimitOptions(createConnection()));
  }

  app.get('/', async () => ({
    name: 'knn-api',
    version: rootVersion(),
    env: env.APP_ENV,
  }));

  await registerHealth(app);
  await registerBullBoard(app);

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(facebookRoutes, { prefix: '/api/facebook' });
  await app.register(adsenseRoutes, { prefix: '/api/adsense' });
  await app.register(domainRoutes, { prefix: '/api/domains' });
  await app.register(campaignRoutes, { prefix: '/api/campaigns' });
  await app.register(statsRoutes, { prefix: '/api/stats' });
  await app.register(uploadRoutes, { prefix: '/api/uploads' });
  await app.register(publicArticleRoutes, { prefix: '/api/public/articles' });
  await app.register(publicEdgeRoutes, { prefix: '/api/public' });
  await app.register(internalRoutes, { prefix: '/api/internal' });
  await app.register(eventsRoutes, { prefix: '/api/events' });
  await app.register(termTelemetryRoutes, { prefix: '/api/telemetry' });

  return app;
}
