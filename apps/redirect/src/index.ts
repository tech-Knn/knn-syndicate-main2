import { serve } from '@hono/node-server';
import { env } from '@knn/config';
import { buildApp, closeRedis } from './app.js';

const app = buildApp();

const server = serve({ fetch: app.fetch, port: env.REDIRECT_PORT }, (info) => {
  console.log(`[redirect] listening on :${info.port} (${env.APP_ENV})`);
});

const shutdown = (signal: string): void => {
  console.log(`[redirect] ${signal} received, closing`);
  server.close(() => {
    void closeRedis().finally(() => process.exit(0));
  });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
