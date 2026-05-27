import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Provide a real `require` in the ESM bundle so bundled CJS deps (e.g. dotenv)
  // that call require('fs') work instead of hitting esbuild's throwing shim.
  banner: {
    js: "import { createRequire as _knnCreateRequire } from 'module'; const require = _knnCreateRequire(import.meta.url);",
  },
  // Bundle the workspace packages' source; keep native/stateful libraries
  // external so they're resolved from node_modules at runtime.
  noExternal: [/^@knn\//],
  external: ['@prisma/client', '.prisma/client', '@prisma/engines', 'bullmq', 'ioredis'],
});
