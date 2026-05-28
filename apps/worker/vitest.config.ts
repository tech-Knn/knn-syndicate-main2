import { defineConfig } from 'vitest/config';

/**
 * Worker tests hit one shared Postgres and exercise GLOBAL (cross-org) operations —
 * the channel pool (`FOR UPDATE SKIP LOCKED`, rollover), meta-rejection's ACTIVE-
 * campaign scan, and revenue attribution. Unlike the RLS-scoped API tests, these
 * scan/mutate rows across orgs, so running test FILES in parallel lets one file's
 * fixtures leak into another's global scan. Serialize files so each file's
 * beforeAll/afterAll isolation holds.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
