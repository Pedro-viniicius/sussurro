import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// Integração: Postgres do docker-compose (padrão) ou PGlite em memória com TEST_DB=pglite
// (packages/db/src/testing). Localmente lê o .env da raiz; no CI as variáveis vêm do workflow.
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  resolve: { conditions: ['@sussurro/source'] },
  test: {
    include: ['src/**/*.int.test.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
