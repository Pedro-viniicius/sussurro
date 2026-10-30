import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { swcPlugin } from './swc.config.js';

// Integração do worker: Postgres do docker-compose (padrão) ou PGlite com TEST_DB=pglite.
// Localmente lê o .env da raiz; no CI as variáveis vêm do workflow.
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  plugins: [swcPlugin()],
  resolve: { conditions: ['@sussurro/source'] },
  ssr: { resolve: { conditions: ['@sussurro/source'] } },
  test: {
    fsModuleCache: false,
    include: ['test/**/*.int-spec.ts'],
    setupFiles: ['src/testing/setup.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
