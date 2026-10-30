import { defineConfig } from 'vitest/config';

import { swcPlugin } from './swc.config.js';

// Unitários (sem Docker). Mesmo SWC do build (.swcrc), ver apps/api/vitest.config.ts.
export default defineConfig({
  plugins: [swcPlugin()],
  resolve: { conditions: ['@sussurro/source'] },
  ssr: { resolve: { conditions: ['@sussurro/source'] } },
  test: {
    fsModuleCache: false,
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/testing/setup.ts'],
    env: { TZ: 'UTC' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.spec.ts', 'src/testing/**', 'src/main.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
