// Pacotes e apps Node (shared, db, api, worker).
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { baseConfig } from './base.mjs';

/**
 * @param {{ tsconfigRootDir: string, restrictReactAndNest?: boolean }} options
 */
export function nodeConfig({ tsconfigRootDir, restrictReactAndNest = false }) {
  return tseslint.config(
    ...baseConfig({ tsconfigRootDir }),
    {
      languageOptions: { globals: { ...globals.node } },
      rules: {
        'no-console': 'error',
      },
    },
    {
      // Nest usa classes vazias decoradas (módulos) e injeção por construtor.
      files: ['**/*.module.ts'],
      rules: { '@typescript-eslint/no-extraneous-class': 'off' },
    },
    {
      files: [
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/*.e2e-spec.ts',
        '**/*.int.test.ts',
        '**/*.int-spec.ts',
      ],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/unbound-method': 'off',
      },
    },
    restrictReactAndNest
      ? {
          // packages/shared é consumido pelo app e pela API: não pode depender de React nem de Nest.
          rules: {
            'no-restricted-imports': [
              'error',
              {
                patterns: [
                  {
                    group: ['react', 'react-native', 'react/*', 'react-native/*', '@nestjs/*'],
                    message: 'packages/shared não pode importar React nem NestJS.',
                  },
                ],
              },
            ],
          },
        }
      : {},
  );
}
