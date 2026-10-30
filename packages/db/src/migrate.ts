import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { Db } from './client.ts';

/**
 * Pasta das migrations versionadas (geradas pelo drizzle-kit). O caminho vale tanto para
 * `src/` quanto para `dist/`, que ficam no mesmo nível dentro do pacote.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Aplica as migrations pendentes (mesma tabela de controle do `drizzle-kit migrate`). Usado pelos
 * testes contra o Postgres do compose e, na Fase 7, pela task de migration do deploy.
 */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
