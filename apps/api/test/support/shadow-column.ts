// R25 (arquitetura.md §16): a coluna de fora numa subconsulta da lista do `select`. Os testes abaixo
// dão uma coluna `id` à tabela da subconsulta (`connections` ou `follows`), que hoje não tem, e
// conferem que o campo continua lendo o `users.id` de fora. Com `${users.id}` no lugar de
// `qualified(users.id)`, o Drizzle escreve `"id"`, que passaria a ser o `id` da subconsulta, e o
// campo viraria sempre falso, sem erro.
import { type Database, sql } from '@sussurro/db';

/** Só para desfazer a transação de propósito: o Drizzle desfaz e repassa o erro. */
class Rollback extends Error {}

/** As tabelas das duas subconsultas do R25 (`findNearby` e `searchCreators`). */
export type ShadowTable = 'connections' | 'follows';

/**
 * Roda `run` numa transação em que `table` ganha uma coluna `id` (uuid preenchido, diferente de
 * todo id de conta) e desfaz tudo no fim, com o resultado de `run`. A DDL é transacional no
 * Postgres e no PGlite: depois do `rollback`, a tabela volta a ser a das migrations (confira com
 * `hasColumn`). `run` recebe a transação para montar o repositório sobre ela.
 */
export async function withShadowIdColumn<T>(
  db: Database,
  table: ShadowTable,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  let outcome: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`alter table "${table}" add column "id" uuid not null default gen_random_uuid()`),
      );
      if (!(await hasColumn(tx, table, 'id'))) {
        throw new Error(`a coluna "id" não apareceu em "${table}" dentro da transação`);
      }
      outcome = { value: await run(tx) };
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (outcome === undefined) {
    throw new Error('withShadowIdColumn: a transação terminou sem rodar o teste');
  }
  return outcome.value;
}

/** A coluna existe na tabela (schema corrente)? */
export async function hasColumn(db: Database, table: string, column: string): Promise<boolean> {
  const result: unknown = await db.execute(sql`
    select 1 as found
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = ${table}
       and column_name = ${column}`);
  return ((result as { rows?: unknown[] }).rows ?? []).length > 0;
}
