import { defineConfig } from 'vitest/config';

import { swcPlugin } from './swc.config.js';

// Unitários (sem Docker). O SWC transforma o TS com as opções do .swcrc (legacyDecorator +
// decoratorMetadata), que é o que o Nest precisa para injeção por tipo (risco F0-4).
export default defineConfig({
  plugins: [swcPlugin()],
  resolve: { conditions: ['@sussurro/source'] },
  ssr: { resolve: { conditions: ['@sussurro/source'] } },
  test: {
    // O cache de transformação do Vitest não enxerga mudanças no .swcrc (lido pelo plugin):
    // desligado para o teste-sentinela F0-Q-08 ser confiável.
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
