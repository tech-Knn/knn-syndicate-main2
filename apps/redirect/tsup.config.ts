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
  // Bundle workspace source; keep the native/stateful Redis client external.
  noExternal: [/^@knn\//],
  external: ['ioredis'],
});
