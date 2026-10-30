import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Carrega o `.env` da raiz do monorepo, se existir (desenvolvimento local).
 * Variáveis já definidas no ambiente têm prioridade. Em produção não há arquivo.
 * O caminho vale tanto para `src/config` quanto para `dist/config`.
 */
export function loadRootEnvFile(
  path: string = fileURLToPath(new URL('../../../../.env', import.meta.url)),
): boolean {
  if (!existsSync(path)) {
    return false;
  }
  process.loadEnvFile(path);
  return true;
}
