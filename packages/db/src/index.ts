import { env } from '@knn/config';
import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * Single shared PrismaClient. Connects as the NON-superuser app role
 * (APP_DATABASE_URL) so Row-Level Security is enforced; falls back to
 * DATABASE_URL if the app role hasn't been bootstrapped yet. The URL is passed
 * explicitly from validated `@knn/config` env so it's always present before the
 * engine starts, regardless of import order in tests/workers.
 */
const globalForPrisma = globalThis as unknown as { __knnPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__knnPrisma ??
  new PrismaClient({
    datasourceUrl: env.APP_DATABASE_URL ?? env.DATABASE_URL,
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__knnPrisma = prisma;
}

/** A Prisma client bound to an open transaction (with the RLS context applied). */
export type TxClient = Prisma.TransactionClient;

/**
 * Run `fn` inside a transaction scoped to one org. Sets the transaction-local
 * `app.current_org` GUC so RLS filters every query to that org. Use for all
 * tenant (COMPANY_ADMIN / MEDIA_BUYER) operations. Queries MUST use the passed
 * `tx`, not the bare `prisma`, or they won't see the context.
 */
export async function withTenant<T>(orgId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
    return fn(tx);
  });
}

/**
 * Run `fn` inside a transaction with RLS bypassed (sets `app.bypass_rls`). Use
 * for SUPER_ADMIN and trusted system/background work — auth lookups (which
 * happen before any org context exists), crons, and platform-wide queries.
 *
 * `opts` is forwarded to `$transaction` (e.g. a higher `timeout` for a batch that does many
 * writes in one atomic unit, past the default 5s interactive-transaction limit). Existing callers
 * pass nothing → unchanged default behaviour.
 */
export async function withSystem<T>(
  fn: (tx: TxClient) => Promise<T>,
  opts?: { timeout?: number; maxWait?: number },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  }, opts);
}

export * from '@prisma/client';
