import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  banner: {
    js: "import { createRequire as _knnCreateRequire } from 'module'; const require = _knnCreateRequire(import.meta.url);",
  },
  noExternal: [/^@knn\//],
  external: ['@prisma/client', '.prisma/client', '@prisma/engines', 'bullmq', 'ioredis'],
});
