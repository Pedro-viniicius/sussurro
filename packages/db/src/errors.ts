/** SQLSTATEs do Postgres tratados pela aplicação. */
export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
} as const;

export interface PgErrorInfo {
  /** SQLSTATE de 5 caracteres (ex.: `23505`). */
  code: string;
  /** Nome da constraint violada, quando o servidor informa. */
  constraint: string | undefined;
}

/**
 * Acha o erro do Postgres na cadeia de `cause`: o Drizzle embrulha o erro do driver
 * (`node-postgres` ou PGlite), e os dois expõem `code` e `constraint`.
 */
export function findPgError(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { code, constraint, cause } = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
    }
    current = cause;
  }
  return undefined;
}
