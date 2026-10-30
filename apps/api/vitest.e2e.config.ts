import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { swcPlugin } from './swc.config.js';

// E2E: Postgres e Valkey do docker-compose (padrão) ou PGlite em memória com TEST_DB=pglite
// (test/support/test-app.ts). Localmente lê o .env da raiz; no CI as variáveis vêm do workflow.
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

// Cada arquivo sobe um PGlite (~100 MB): limita os workers para caber em 7,7 GB de RAM.
const pglite = process.env.TEST_DB === 'pglite';

export default defineConfig({
  plugins: [swcPlugin()],
  resolve: { conditions: ['@sussurro/source'] },
  ssr: { resolve: { conditions: ['@sussurro/source'] } },
  test: {
    // O cache de transformação do Vitest não enxerga mudanças no .swcrc (lido pelo plugin):
    // desligado para o teste-sentinela F0-Q-08 ser confiável.
    fsModuleCache: false,
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['src/testing/setup.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    ...(pglite ? { maxWorkers: 2 } : {}),
  },
});
