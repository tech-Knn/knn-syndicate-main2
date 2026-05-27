import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { env, rootVersion } from '@knn/config';
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

  app.get('/', async () => ({
    name: 'knn-api',
    version: rootVersion(),
    env: env.APP_ENV,
  }));

  await registerHealth(app);
  await registerBullBoard(app);

  return app;
}
