/**
 * Texto curto para log a partir de qualquer erro. Segue a cadeia de `cause` (o Drizzle
 * embrulha o erro do `pg`) e usa o `code` quando a mensagem vem vazia (ECONNREFUSED no
 * Windows chega como AggregateError sem mensagem).
 */
export function describeError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { code } = error as { code?: unknown };
  const own = error.message.trim() || (typeof code === 'string' ? code : '') || error.name;
  if (error.cause !== undefined && depth < 3) {
    return `${own} <- ${describeError(error.cause, depth + 1)}`;
  }
  return own;
}
