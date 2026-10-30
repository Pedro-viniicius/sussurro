import { describeSafeError } from '@sussurro/shared';

/**
 * Texto curto e limpo para log a partir de qualquer erro (PERM-17). Segue a cadeia de `cause` (o
 * Drizzle embrulha o erro do `pg`) e usa o `code` quando a mensagem vem vazia (ECONNREFUSED no
 * Windows chega como AggregateError sem mensagem). Do `DrizzleQueryError` sai só o SQL, nunca os
 * `params` (e-mail, hash da senha, nome, textos); do erro do driver, a mensagem e o SQLSTATE.
 */
export function describeError(error: unknown): string {
  return describeSafeError(error);
}
