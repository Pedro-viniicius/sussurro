import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import swc from 'unplugin-swc';

/**
 * Plugin do SWC para o Vitest usando as opções do `.swcrc` (o mesmo arquivo do `nest build`).
 * O unplugin-swc monta um `jsc` próprio que se sobrepõe ao `.swcrc`; por isso lemos o arquivo
 * e passamos as opções explicitamente. Tirar `decoratorMetadata` do `.swcrc` quebra a injeção
 * por tipo do Nest e o app.module.spec.ts falha (teste-sentinela F0-Q-08).
 */
export function swcPlugin() {
  const { $schema: _schema, ...options } = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '.swcrc'), 'utf8'),
  ) as Record<string, unknown>;
  return swc.vite({ ...options, tsconfigFile: false, swcrc: false });
}
