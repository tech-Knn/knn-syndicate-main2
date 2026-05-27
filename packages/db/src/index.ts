import { env } from '@knn/config';
import { PrismaClient } from '@prisma/client';

/**
 * Single shared PrismaClient instance. Re-using one client across the process
 * (and surviving dev hot-reloads via a global) avoids exhausting the connection
 * pool. Tenant scoping (RLS `SET app.current_org`) is layered on top in Phase 1.
 *
 * We pass the URL explicitly from the validated `@knn/config` env rather than
 * relying on Prisma's own `process.env` resolution — this guarantees the env is
 * loaded (dotenv side-effect) before the engine starts, regardless of import
 * order in tests or workers.
 */
const globalForPrisma = globalThis as unknown as { __knnPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__knnPrisma ??
  new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__knnPrisma = prisma;
}

export * from '@prisma/client';
export { PrismaClient };
