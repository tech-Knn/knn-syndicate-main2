import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { env, rootVersion } from '@knn/config';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { publicArticleRoutes } from './modules/articles/articles.routes.js';
import { internalRoutes } from './modules/internal/internal.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { campaignRoutes } from './modules/campaigns/campaigns.routes.js';
import { facebookRoutes } from './modules/facebook/facebook.routes.js';
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
  await app.register(campaignRoutes, { prefix: '/api/campaigns' });
  await app.register(uploadRoutes, { prefix: '/api/uploads' });
  await app.register(publicArticleRoutes, { prefix: '/api/public/articles' });
  await app.register(internalRoutes, { prefix: '/api/internal' });

  return app;
}
