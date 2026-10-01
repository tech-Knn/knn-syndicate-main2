import { defineConfig } from 'vitest/config';

// Unit tests for the AFS markup the article app emits (the inline bootstraps that fire Google's ad calls).
// Components are rendered to static HTML on the server side; no browser, no Next runtime.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['app/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
