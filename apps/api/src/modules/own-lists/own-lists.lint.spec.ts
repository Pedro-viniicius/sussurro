// História 3.6 CA5 (ADR 0004): a regra de lint impede importar as funções de listagem fora do
// controller dono. O teste usa o ESLint de verdade: confere que a configuração do pacote aplica a
// regra a cada arquivo e roda as mesmas regras (`ownListsImportRules`) sobre imports de exemplo.
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const apiRoot = fileURLToPath(new URL('../../../', import.meta.url));

const IMPORT_REPOSITORY = (path: string) =>
  `import { OwnListsRepository } from '${path}';\nexport const lists = OwnListsRepository;\n`;
const IMPORT_SERVICE = (path: string) =>
  `import { OwnListsService } from '${path}';\nexport const lists = OwnListsService;\n`;

describe('regra de lint das listas próprias (3.6 CA5)', () => {
  /** Só as regras de import (sem o type-checker, que levaria dezenas de segundos para subir). */
  let rulesOnly: ESLint;

  beforeAll(async () => {
    // As mesmas regras que o eslint.config.mjs do pacote exporta e aplica.
    const { ownListsImportRules } = (await import(
      pathToFileURL(`${apiRoot}eslint.config.mjs`).href
    )) as { ownListsImportRules: Linter.Config[] };
    rulesOnly = new ESLint({
      cwd: apiRoot,
      overrideConfigFile: true,
      overrideConfig: [{ files: ['**/*.ts'] }, ...ownListsImportRules],
    });
  });

  /** Mensagens do `no-restricted-imports` ao lintar `code` como se fosse o arquivo `file`. */
  async function restrictedImports(file: string, code: string): Promise<string[]> {
    const [result] = await rulesOnly.lintText(code, { filePath: `${apiRoot}${file}` });
    return (result?.messages ?? [])
      .filter((message) => message.ruleId === 'no-restricted-imports')
      .map((message) => message.message);
  }

  it('a configuração do pacote (pnpm lint) aplica a regra fora do módulo das listas', async () => {
    const eslint = new ESLint({ cwd: apiRoot });
    const config = (await eslint.calculateConfigForFile(
      `${apiRoot}src/modules/feed/feed.service.ts`,
    )) as { rules: Record<string, unknown> };
    expect(JSON.stringify(config.rules['no-restricted-imports'])).toContain(
      'own-lists\\\\.repository',
    );
    expect(JSON.stringify(config.rules['no-restricted-imports'])).toContain(
      'own-lists\\\\.service',
    );
  });

  it('importar o repositório ou o service de listagem em outro módulo falha o lint', async () => {
    const file = 'src/modules/feed/feed.service.ts';
    const repository = await restrictedImports(
      file,
      IMPORT_REPOSITORY('../own-lists/own-lists.repository.js'),
    );
    expect(repository).toHaveLength(1);
    expect(repository[0]).toContain('MeListsController');
    expect(
      await restrictedImports(file, IMPORT_SERVICE('../own-lists/own-lists.service.js')),
    ).toHaveLength(1);
    // Nos testes também: um e2e não monta uma lista por fora da rota.
    expect(
      await restrictedImports(
        'test/e2e/feed.e2e-spec.ts',
        IMPORT_REPOSITORY('../../src/modules/own-lists/own-lists.repository.js'),
      ),
    ).toHaveLength(1);
  });

  it('o controller dono importa o service, mas não o repositório', async () => {
    const controller = 'src/modules/own-lists/own-lists.controller.ts';
    expect(await restrictedImports(controller, IMPORT_SERVICE('./own-lists.service.js'))).toEqual(
      [],
    );
    expect(
      await restrictedImports(controller, IMPORT_REPOSITORY('./own-lists.repository.js')),
    ).toHaveLength(1);
  });

  it('o service importa o repositório', async () => {
    expect(
      await restrictedImports(
        'src/modules/own-lists/own-lists.service.ts',
        IMPORT_REPOSITORY('./own-lists.repository.js'),
      ),
    ).toEqual([]);
  });
});
