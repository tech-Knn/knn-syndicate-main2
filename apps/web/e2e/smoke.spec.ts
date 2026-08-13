import { expect, test } from '@playwright/test';

/**
 * Auth-flow smoke — the verified baseline of the E2E harness. Web-server only (no API needed):
 * the login page is client-rendered, and the dashboard's auth gate treats a missing/invalid
 * session as "anon" and redirects to /login. Low-brittleness (role/label selectors only).
 */
test.describe('auth flow (smoke)', () => {
  test('the login page renders the sign-in form', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Password' })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /create an account/i })).toBeVisible();
  });

  test('an unauthenticated visit to the dashboard redirects to login', async ({ page }) => {
    await page.goto('/dashboard');
    // The auth gate (dashboard layout) resolves to "anon" and routes to /login.
    await expect(page).toHaveURL(/\/login(\?|$|\/)/);
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
  });

  test('the signup page is reachable from login', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: /create an account/i }).click();
    await expect(page).toHaveURL(/\/signup/);
  });
});
