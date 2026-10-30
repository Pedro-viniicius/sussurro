/**
 * Linhas de um `db.execute(sql…)`. O tipo `Database` é comum ao `node-postgres` e ao PGlite, e o
 * resultado dos dois tem `rows`, mas o tipo genérico do Drizzle não expõe o campo.
 */
export function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}
