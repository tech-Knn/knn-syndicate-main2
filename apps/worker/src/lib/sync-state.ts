import { withSystem } from '@knn/db';
import { SYNC_STATE_KEYS } from '@knn/shared';

/**
 * Last-successful-run timestamps for the scheduled syncs, surfaced to buyers as the Analytics
 * "auto-updates • last updated X ago" indicator. Stored in the generic platform_settings KV so
 * no migration is needed. These are the ONLY freshness signal the UI shows — there is no manual
 * refresh (it would breach the per-account Meta / project-wide AdSense rate limits). Keys are the
 * worker↔API contract from @knn/shared.
 */
export const SYNC_KEYS = SYNC_STATE_KEYS;

/** Record that a scheduled sync finished just now (idempotent upsert into platform_settings). */
export async function markSyncRun(key: string): Promise<void> {
  const value = new Date().toISOString();
  await withSystem((tx) =>
    tx.platformSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    }),
  );
}
