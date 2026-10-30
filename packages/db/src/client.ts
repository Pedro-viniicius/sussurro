import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';

import * as schema from './schema/index.ts';

export type Schema = typeof schema;

/**
 * Tipo comum do Drizzle para Postgres. Os repositórios tipam contra ele, e não contra o driver:
 * em produção é o `node-postgres`; nos testes pode ser o PGlite (`TEST_DB=pglite`).
 */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

/** Transação aberta por `db.transaction(...)`. */
export type Transaction = PgTransaction<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

/** Onde uma consulta pode rodar: no banco ou dentro de uma transação. */
export type DbExecutor = Database | Transaction;

/** Instância do Drizzle com o driver `node-postgres` (API e worker). */
export type Db = NodePgDatabase<Schema>;

export interface CreateDbOptions {
  /** Máximo de conexões do pool. */
  max?: number;
  /** Tempo máximo para abrir uma conexão (ms). Curto, para o `/health/ready` não travar. */
  connectionTimeoutMillis?: number;
  /** Tempo até fechar uma conexão ociosa (ms). */
  idleTimeoutMillis?: number;
  /** Aparece em `pg_stat_activity`; ajuda a saber se a conexão é da API ou do worker. */
  applicationName?: string;
  /**
   * Erros de conexões ociosas (ex.: Postgres reiniciou). Sem este handler o `pg`
   * emite `error` sem ouvinte e derruba o processo.
   */
  onIdleError?: (error: Error) => void;
}

/** O que a API e o worker injetam: o banco e como fechá-lo. */
export interface DbHandle {
  db: Database;
  /** Fecha as conexões. Pode ser chamado mais de uma vez. */
  close: () => Promise<void>;
}

/** Handle de produção, com o pool do `pg`. */
export interface NodePgDbHandle extends DbHandle {
  db: Db;
  pool: pg.Pool;
}

export class InvalidDatabaseUrlError extends Error {
  constructor(reason: string) {
    super(`DATABASE_URL inválida: ${reason}`);
    this.name = 'InvalidDatabaseUrlError';
  }
}

const DEFAULTS = {
  max: 10,
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 30_000,
  applicationName: 'sussurro',
} as const;

/** Valida a URL de conexão sem expor a senha na mensagem de erro. */
export function parseDatabaseUrl(url: string): URL {
  if (url.trim() === '') {
    throw new InvalidDatabaseUrlError('vazia');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidDatabaseUrlError(
      'não é uma URL (esperado postgres://usuario:senha@host:5432/banco)',
    );
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new InvalidDatabaseUrlError(
      `protocolo "${parsed.protocol}" não suportado (use postgres:// ou postgresql://)`,
    );
  }
  if (parsed.hostname === '') {
    throw new InvalidDatabaseUrlError('sem host');
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    throw new InvalidDatabaseUrlError('sem nome do banco');
  }
  return parsed;
}

/**
 * Cria o pool do `pg` e a instância do Drizzle. O pool é preguiçoso: nenhuma
 * conexão é aberta até a primeira consulta.
 */
export function createDb(url: string, options: CreateDbOptions = {}): NodePgDbHandle {
  parseDatabaseUrl(url);

  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? DEFAULTS.max,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULTS.connectionTimeoutMillis,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULTS.idleTimeoutMillis,
    application_name: options.applicationName ?? DEFAULTS.applicationName,
  });

  const onIdleError = options.onIdleError ?? (() => undefined);
  pool.on('error', onIdleError);

  const db = drizzle({ client: pool, schema });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= pool.end();
    return closing;
  };

  return { db, pool, close };
}

/** `select 1`: usado pelo `/health/ready` da API. */
export async function pingDatabase(handle: Pick<DbHandle, 'db'>): Promise<void> {
  await handle.db.execute(sql`select 1`);
}
