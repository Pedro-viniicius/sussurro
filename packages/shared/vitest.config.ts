import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@sussurro/source'] },
  test: {
    include: ['src/**/*.test.ts'],
    env: { TZ: 'UTC' },
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text', 'lcov'] },
  },
});
