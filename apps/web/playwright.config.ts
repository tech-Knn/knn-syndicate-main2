import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E harness for the dashboard (apps/web). Phase 3 gate.
 *
 * What runs today (verified, low-brittleness): the AUTH-FLOW smoke (`e2e/smoke.spec.ts`) —
 * the login page renders and the auth gate redirects an unauthenticated visitor to /login.
 * It needs only the web server, so it's runnable locally with `pnpm e2e` (after
 * `pnpm e2e:install`) and in CI.
 *
 * Next layer (scaffolded in `e2e/campaign.spec.ts`, currently test.fixme): the full
 * "build a 2-adset/4-ad campaign → draft → submit" gate. That needs the API server +
 * a seeded buyer/FB-assets/domain (via @knn/db withSystem) + stable wizard selectors —
 * stabilized against a CI run. See that file's header for the plan.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3003',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Auto-start the web server for the run. The smoke spec only exercises client-rendered
  // pages, so the API isn't required; reuse a server you already have running locally.
  webServer: {
    command: 'pnpm --filter @knn/web dev',
    url: 'http://localhost:3003',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
