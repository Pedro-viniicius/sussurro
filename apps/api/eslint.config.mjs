import { nodeConfig } from '@sussurro/config/eslint/node';

/**
 * Listas próprias (ADR 0004, história 3.6 CA5): as funções que listam conexões, seguidos e
 * bloqueados (`OwnListsRepository`) só podem ser importadas pelo `OwnListsService`, e o service só
 * pelo controller dono (`MeListsController`). Qualquer outro import falha o `pnpm lint`. O teste
 * `src/modules/own-lists/own-lists.lint.spec.ts` confere a regra.
 */
const OWN_LISTS_DIR = 'src/modules/own-lists';
const MESSAGE =
  'As listas de relacionamento só saem pelo MeListsController (ADR 0004, história 3.6 CA5).';
const REPOSITORY = {
  regex: 'own-lists\\.repository(\\.js)?$',
  message: `${MESSAGE} O OwnListsRepository só é importado pelo OwnListsService.`,
};
const SERVICE = {
  regex: 'own-lists\\.service(\\.js)?$',
  message: `${MESSAGE} O OwnListsService só é importado pelo controller dono.`,
};

export const ownListsImportRules = [
  {
    // Todo o resto do app (inclusive os testes): nem o repositório nem o service.
    files: ['**/*.ts'],
    ignores: [`${OWN_LISTS_DIR}/**`],
    rules: { 'no-restricted-imports': ['error', { patterns: [REPOSITORY, SERVICE] }] },
  },
  {
    // O controller dono só fala com o service.
    files: [`${OWN_LISTS_DIR}/own-lists.controller.ts`],
    rules: { 'no-restricted-imports': ['error', { patterns: [REPOSITORY] }] },
  },
];

export default [...nodeConfig({ tsconfigRootDir: import.meta.dirname }), ...ownListsImportRules];
