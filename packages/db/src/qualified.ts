import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * A coluna escrita sempre com a tabela (`"users"."id"`), para usar dentro de `sql` na lista de um
 * `select` (R25, arquitetura.md §16).
 *
 * Num `select` de uma tabela só, sem `join`, o Drizzle escreve sem a tabela as colunas da lista,
 * inclusive as que vão direto num `sql`: `${users.id}` vira `"id"`. Numa subconsulta, esse `"id"`
 * se liga à tabela de dentro quando ela tem uma coluna com o mesmo nome, e o campo muda sem erro.
 * Aqui a tabela e o nome da coluna entram como nomes (`Table` e `sql.identifier`), não como coluna,
 * e o Drizzle não os reescreve. No `WHERE`, no `ORDER BY` e em consulta com `join`, ele já põe a
 * tabela: o helper só é preciso na lista do `select`.
 *
 * Sai o nome da coluna no banco: o schema dá nome explícito a toda coluna, e o cliente não usa a
 * opção `casing` do Drizzle. Com uma tabela de `alias()`, sai o alias.
 */
export function qualified(column: AnyPgColumn): SQL {
  return sql`${column.table}.${sql.identifier(column.name)}`;
}
