export {
  createDb,
  InvalidDatabaseUrlError,
  parseDatabaseUrl,
  pingDatabase,
  type CreateDbOptions,
  type Database,
  type Db,
  type DbExecutor,
  type DbHandle,
  type NodePgDbHandle,
  type Schema,
  type Transaction,
} from './client.ts';
export { MIGRATIONS_FOLDER, runMigrations } from './migrate.ts';
export * as schema from './schema/index.ts';
export * from './schema/index.ts';
export { findPgError, PgErrorCode, type PgErrorInfo } from './errors.ts';
export { qualified } from './qualified.ts';
// Operadores do Drizzle reexportados: a API e o worker usam a mesma cópia do drizzle-orm do schema.
export {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
export { alias } from 'drizzle-orm/pg-core';
