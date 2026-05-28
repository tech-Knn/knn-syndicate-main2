import { defineConfig } from 'vitest/config';

/**
 * Most API tests are RLS-scoped (org-isolated) and parallel-safe, but several now touch
 * GLOBAL (no-org) tables — the channel pool, the AFS channel catalog, domains, and the
 * channel-summary aggregate. Running test FILES in parallel lets one file's global rows
 * leak into another's count/scan (an intermittent failure). Serialize files so each
 * file's beforeAll/afterAll isolation holds. (Within a file, tests still run in order.)
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
