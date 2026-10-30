// Conventional Commits em pt-BR (fase-0-plano.md §6.4).
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'refactor',
        'test',
        'docs',
        'chore',
        'build',
        'ci',
        'perf',
        'style',
        'revert',
      ],
    ],
    'scope-enum': [
      2,
      'always',
      ['mobile', 'api', 'worker', 'shared', 'ui', 'db', 'config', 'infra', 'docs', 'deps', 'repo'],
    ],
    // A descrição é em português e pode começar com nome próprio ou sigla.
    'subject-case': [0],
  },
};
