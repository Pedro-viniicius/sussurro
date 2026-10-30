import { randomBytes } from 'node:crypto';

import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';

import { createDb, type Database, type DbHandle } from '../client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../migrate.ts';
import * as schema from '../schema/index.ts';

/**
 * Onde os testes de integração e e2e rodam (testes.md §3.1):
 * - `postgres` (padrão): o Postgres do docker-compose ou o service do CI, via `DATABASE_URL`.
 *   Cada arquivo de teste cria um banco `sussurro_test_*` próprio, aplica as migrations e o apaga
 *   no fim. É o ambiente canônico.
 * - `pglite`: Postgres 18 em WebAssembly, em memória, sem Docker. Escolha explícita com
 *   `TEST_DB=pglite` (sem detecção automática). Aplica as mesmas migrations. Não reproduz várias
 *   conexões simultâneas: os testes que dependem disso são pulados nesse modo.
 */
export type TestDbMode = 'postgres' | 'pglite';

export function testDbMode(env: Record<string, string | undefined> = process.env): TestDbMode {
  const value = env.TEST_DB?.trim();
  if (value === undefined || value === '' || value === 'postgres') {
    return 'postgres';
  }
  if (value === 'pglite') {
    return 'pglite';
  }
  throw new Error(`TEST_DB inválida: "${value}" (use postgres ou pglite).`);
}

/** Atalho para `describe.skipIf(isPgliteMode())` nos testes que exigem Postgres/Redis reais. */
export function isPgliteMode(): boolean {
  return testDbMode() === 'pglite';
}

export interface TestDatabase {
  mode: TestDbMode;
  db: Database;
  /**
   * Para injetar no lugar do `DATABASE` da API ou do worker. O `close` não faz nada: quem fecha
   * o banco é o teste, com `close()` abaixo, depois de fechar o app.
   */
  handle: DbHandle;
  /** Esvazia todas as tabelas do schema (entre testes). */
  truncate: () => Promise<void>;
  close: () => Promise<void>;
}

/** Todas as tabelas do schema, para o TRUNCATE entre testes. */
function schemaTableNames(): string[] {
  return Object.values(schema as Record<string, unknown>)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => `"${getTableName(table)}"`);
}

async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${schemaTableNames().join(', ')} RESTART IDENTITY CASCADE`));
}

async function createPgliteDatabase(): Promise<TestDatabase> {
  // Import dinâmico: o modo postgres (CI) não carrega o WebAssembly do PGlite.
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');

  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  let closed = false;
  return {
    mode: 'pglite',
    db,
    handle: { db, close: () => Promise.resolve() },
    truncate: () => truncateAll(db),
    close: async () => {
      if (!closed) {
        closed = true;
        await client.close();
      }
    },
  };
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL não definida: suba o compose (docker compose up -d --wait) ou rode com TEST_DB=pglite.',
    );
  }
  return url;
}

async function withAdminClient(url: string, run: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: url, application_name: 'sussurro-test-admin' });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

async function createPostgresDatabase(): Promise<TestDatabase> {
  const adminUrl = requireDatabaseUrl();
  const name = `sussurro_test_${String(process.pid)}_${randomBytes(4).toString('hex')}`;
  await withAdminClient(adminUrl, async (client) => {
    await client.query(`CREATE DATABASE "${name}"`);
  });

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle = createDb(url.toString(), { applicationName: 'sussurro-test', max: 10 });
  await runMigrations(handle.db);

  let closed = false;
  return {
    mode: 'postgres',
    db: handle.db,
    handle: { db: handle.db, close: () => Promise.resolve() },
    truncate: () => truncateAll(handle.db),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await handle.close();
      await withAdminClient(adminUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      });
    },
  };
}

/** Banco novo, com todas as migrations aplicadas, no modo escolhido por `TEST_DB`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  return testDbMode() === 'pglite' ? createPgliteDatabase() : createPostgresDatabase();
}
