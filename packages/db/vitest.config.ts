import { defineConfig } from 'vitest/config';

// Unitários: sem banco. Os *.int.test.ts rodam no vitest.int.config.ts (pnpm test:e2e).
export default defineConfig({
  resolve: { conditions: ['@sussurro/source'] },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    env: { TZ: 'UTC' },
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text', 'lcov'] },
  },
});
