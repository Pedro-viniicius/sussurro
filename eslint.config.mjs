// ESLint dos arquivos da raiz que não pertencem a um pacote: infra/ (spike S3/SQS) e scripts/.
// Cada pacote tem o próprio eslint.config.mjs; o ESLint usa o mais próximo de cada arquivo.
// Roda pelo "pnpm lint" (tarefa //#lint:root do turbo).
import { nodeConfig } from './packages/config/eslint/node.mjs';

export default [
  { ignores: ['apps/**', 'packages/**', 'docs/**'] },
  ...nodeConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // Scripts de terminal: o relatório é a saída.
    files: ['infra/**', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
];
