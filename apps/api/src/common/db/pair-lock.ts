import { type DbExecutor, sql } from '@sussurro/db';

/**
 * Trava transacional por par de contas (advisory lock do Postgres, solta no fim da transação).
 * Seguir, bloquear e conectar (Fase 4) pegam a mesma trava para o mesmo par, em qualquer ordem:
 * um follow que corre junto com um bloqueio nunca sobrevive a ele (X.2). Depois da trava, cada
 * consulta da transação já enxerga o que a outra gravou (READ COMMITTED).
 */
export async function lockAccountPair(
  executor: DbExecutor,
  first: string,
  second: string,
): Promise<void> {
  const key = first < second ? `${first}:${second}` : `${second}:${first}`;
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
