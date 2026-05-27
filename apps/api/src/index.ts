import { env } from '@knn/config';
import { buildApp } from './app.js';

const app = await buildApp();

const close = async (signal: string): Promise<void> => {
  app.log.info(`Received ${signal}, shutting down...`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void close('SIGINT'));
process.on('SIGTERM', () => void close('SIGTERM'));

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
