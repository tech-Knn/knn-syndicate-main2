import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the pure logic behind pages (status names, number and time formatting, date ranges).
// Browser behaviour is covered by the Playwright specs in `e2e/`, which this config leaves alone.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
  },
});
