import { expect, test } from '@playwright/test';

/**
 * Phase 3 gate: "build a 2-adset / 4-ad campaign → draft → submit" through the real wizard UI.
 *
 * SCAFFOLD (test.fixme — does not run yet). The full browser flow needs infra this auth-smoke
 * harness deliberately doesn't stand up, so it's documented here rather than shipped unverified:
 *   1. API server alongside the web — add to playwright.config `webServer`:
 *        `pnpm --filter @knn/api dev` on :3000 (DATABASE_URL/JWT env),
 *      and start the web with NEXT_PUBLIC_API_BASE=http://localhost:3000.
 *   2. A seeded, logged-in MEDIA_BUYER with FB assets + a LIVE domain — seed via @knn/db
 *      `withSystem` in a Playwright setup project, then persist storageState. The exact
 *      fixture graph is in apps/api `campaigns.test.ts` beforeAll (org → buyer → FbConnection
 *      → FbAdAccount → FbPage → FbPixel → LIVE Domain).
 *   3. Stable wizard selectors — add data-testid hooks to campaign-wizard.tsx (step nav,
 *      add-ad-set / add-ad, creative upload, Submit) and drive the three steps.
 * Stabilize against a CI run before removing `.fixme`.
 *
 * NOTE: the API-level equivalent of this gate is already covered and passing
 * (apps/api campaigns.test.ts: create → PATCH a 2-ad-set/4-ad draft → submit →
 * PENDING_APPROVAL, plus clone/preset/bulk). This spec adds the browser layer on top.
 */
test.fixme(
  'buyer builds a 2-adset / 4-ad campaign in the wizard, saves a draft, and submits it',
  async ({ page }) => {
    await page.goto('/dashboard/campaigns/new');
    // Step 0 (Offer): name, keywords, RAC, FB account/page, ≥1 destination website.
    // Step 1 (Ad Sets): add a 2nd ad set; give each 2 ads with an uploaded creative.
    // Step 2 (Review): Save draft, then Submit.
    await expect(page.getByRole('button', { name: /submit/i })).toBeVisible();
  },
);
