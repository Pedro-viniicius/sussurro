// App Expo e packages/ui: base + react-hooks + eslint-plugin-expo.
//
// Divergência registrada (fase-0-plano.md §12): o plano previa o `eslint-config-expo`, mas ele
// traz eslint-plugin-react 7.37 e eslint-plugin-import 2.32, que não declaram suporte ao
// ESLint 10 (peer dependency não resolvida no `pnpm install`). Usamos direto os plugins que
// suportam o ESLint 10: react-hooks (regras de hooks) e expo (variáveis EXPO_PUBLIC_*).
import expoPlugin from 'eslint-plugin-expo';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { baseConfig } from './base.mjs';

/**
 * @param {{ tsconfigRootDir: string }} options
 */
export function reactNativeConfig({ tsconfigRootDir }) {
  return tseslint.config(
    ...baseConfig({ tsconfigRootDir }),
    reactHooks.configs.flat['recommended-latest'],
    {
      plugins: { expo: expoPlugin },
      languageOptions: {
        globals: { ...globals.browser, __DEV__: 'readonly' },
      },
      rules: {
        'expo/no-env-var-destructuring': 'error',
        'expo/no-dynamic-env-var': 'error',
        // O app nunca acessa o banco direto (arquitetura.md §5).
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@sussurro/db', '@sussurro/db/*'],
                message: 'O app não pode importar @sussurro/db.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['**/*.{js,cjs}', 'scripts/**/*.mjs'],
      languageOptions: { globals: { ...globals.node } },
      rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/jest.setup.ts'],
      languageOptions: { globals: { ...globals.jest } },
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/unbound-method': 'off',
        // As props das instâncias de teste são `any` (test-renderer).
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
      },
    },
  );
}
