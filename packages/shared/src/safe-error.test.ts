import { describe, expect, it } from 'vitest';

import { describeSafeError, SAFE_ERROR_MAX_CAUSE_DEPTH, sanitizeError } from './safe-error.ts';

/** Valores de uma consulta que falhou (fictícios; PERM-17). */
const VALUES = {
  email: 'ana.souza+teste@exemplo.com.br',
  hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsLWZpY3RpY2lv$aGFzaC1maWN0aWNpby1kZS10ZXN0ZQ', // gitleaks:allow
  name: 'Ana Souza Fictícia',
  // Um valor com quebra de linha que imita um frame do stack.
  bio: 'minha bio\n    at frameFalsoDaBio (bio.js:1:1)',
};

const SQL = 'update "users" set "email" = $1, "password_hash" = $2, "name" = $3, "bio" = $4';

/** Mesma forma do `DrizzleQueryError` do drizzle-orm 0.45 (o shared não depende do drizzle). */
class DrizzleQueryError extends Error {
  constructor(
    public query: string,
    public params: unknown[],
    cause?: Error,
  ) {
    super(`Failed query: ${query}\nparams: ${params.join(',')}`);
    Error.captureStackTrace(this, DrizzleQueryError);
    if (cause) {
      this.cause = cause;
    }
  }
}

/** Erro do driver (`pg`): `code` = SQLSTATE; o `detail` às vezes traz valores. */
function driverError(): Error {
  return Object.assign(new Error('canceling statement due to statement timeout'), {
    name: 'error',
    code: '57014',
    severity: 'ERROR',
    detail: `Key (email)=(${VALUES.email})`,
  });
}

function queryError(): DrizzleQueryError {
  return new DrizzleQueryError(SQL, Object.values(VALUES), driverError());
}

function leaks(text: string): string[] {
  return Object.entries({ ...VALUES, bio: 'frameFalsoDaBio', salt: 'c2FsLWZpY3RpY2lv' })
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name);
}

/** Tudo o que um log ou o Sentry poderiam ler do erro limpo. */
function everything(error: Error): string {
  const parts: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    parts.push(current.name, current.message, current.stack ?? '', JSON.stringify(current));
  }
  return parts.join('\n');
}

describe('sanitizeError (PERM-17)', () => {
  it('[PERM-17] DrizzleQueryError: só o SQL, a mensagem e o SQLSTATE do driver; sem params nem detail', () => {
    const original = queryError();
    expect(leaks(original.stack ?? '')).not.toEqual([]); // controle: o original vaza

    const safe = sanitizeError(original);
    expect(safe).not.toBe(original);
    expect(safe.name).toBe('DrizzleQueryError');
    expect(safe.message).toBe(`Failed query: ${SQL}`);
    expect(safe).not.toHaveProperty('params');
    expect(safe).not.toHaveProperty('query');
    const cause = safe.cause as Error & { code?: string };
    expect(cause.message).toBe('canceling statement due to statement timeout [57014]');
    expect(cause.code).toBe('57014');
    expect(cause).not.toHaveProperty('detail');
    expect(leaks(everything(safe))).toEqual([]);
  });

  it('[PERM-17] o stack é refeito só com os frames, sem a mensagem original nem frame imitado', () => {
    const original = queryError();
    const safe = sanitizeError(original);
    const lines = (safe.stack ?? '').split('\n');
    expect(lines[0]).toBe(`DrizzleQueryError: Failed query: ${SQL}`);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => /^\s+at\s/.test(line))).toBe(true);
    expect(safe.stack).not.toContain('params');
    expect(safe.stack).not.toContain('frameFalsoDaBio');
    // Os frames de verdade continuam (é o que o Sentry usa para agrupar).
    const originalFrames = (original.stack ?? '').split('\n').filter((l) => /^\s+at\s/.test(l));
    expect(lines.slice(1)).toEqual(originalFrames.filter((l) => !l.includes('frameFalsoDaBio')));
  });

  it('[PERM-17] detecta pela forma (query + params) mesmo com outro nome de classe', () => {
    const shaped = Object.assign(new Error(`Failed query: ${SQL}\nparams: ${VALUES.email}`), {
      query: SQL,
      params: [VALUES.email],
    });
    const safe = sanitizeError(shaped);
    expect(safe.name).toBe('DrizzleQueryError');
    expect(safe.message).toBe(`Failed query: ${SQL}`);
    expect(leaks(everything(safe))).toEqual([]);
  });

  it('[PERM-17] erro qualquer com valor na mensagem passa pelo scrubText', () => {
    const safe = sanitizeError(new Error(`falhou para ${VALUES.email} com ${VALUES.hash}`));
    expect(safe.message).toBe('falhou para [Filtered] com [Filtered]');
    expect(leaks(everything(safe))).toEqual([]);
  });

  it('cadeia de cause limitada (inclusive ciclo)', () => {
    const cyclic = new Error('a');
    cyclic.cause = cyclic;
    let depth = 0;
    for (let current: unknown = sanitizeError(cyclic); current instanceof Error;) {
      depth += 1;
      current = current.cause;
    }
    expect(depth).toBe(SAFE_ERROR_MAX_CAUSE_DEPTH + 1);
  });

  it('código e nome estranhos não saem; valor que não é Error vira texto limpo', () => {
    const odd = Object.assign(new Error('x'), { name: 'nome com espaço', code: 'a b c' });
    const safe = sanitizeError(odd);
    expect(safe.name).toBe('Error');
    expect(safe).not.toHaveProperty('code');
    expect(sanitizeError(`texto com ${VALUES.email}`).message).toBe('texto com [Filtered]');
    expect(sanitizeError(undefined).message).toBe('undefined');
    expect(sanitizeError(Object.create(null)).message).toBe('Erro sem descrição');
    expect(sanitizeError({ message: 'parecido com Error', code: 'E1' }).message).toBe(
      'parecido com Error [E1]',
    );
  });

  it('o código do domínio continua no erro limpo (o beforeSend da API usa)', () => {
    const domain = Object.assign(new Error('Valkey fora'), { code: 'PROXIMITY_UNAVAILABLE' });
    expect(sanitizeError(domain).code).toBe('PROXIMITY_UNAVAILABLE');
  });

  it('é idempotente', () => {
    const once = sanitizeError(queryError());
    const twice = sanitizeError(once);
    expect(twice.message).toBe(once.message);
    expect(twice.stack).toBe(once.stack);
    expect((twice.cause as Error).message).toBe((once.cause as Error).message);
  });
});

describe('describeSafeError (PERM-17)', () => {
  it('[PERM-17] DrizzleQueryError: SQL <- mensagem do driver [SQLSTATE], sem os valores', () => {
    const text = describeSafeError(queryError());
    expect(text).toBe(
      `Failed query: ${SQL} <- canceling statement due to statement timeout [57014]`,
    );
    expect(leaks(text)).toEqual([]);
  });

  it('[PERM-17] withStack junta só os frames do erro de cima', () => {
    const text = describeSafeError(queryError(), { withStack: true });
    const [first, ...frames] = text.split('\n');
    expect(first).toBe(
      `Failed query: ${SQL} <- canceling statement due to statement timeout [57014]`,
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((line) => /^\s+at\s/.test(line))).toBe(true);
    expect(leaks(text)).toEqual([]);
    expect(describeSafeError('sem stack', { withStack: true })).toBe('sem stack');
  });

  it('mensagem vazia usa o code; segue a cadeia de cause; aceita não-Error', () => {
    const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(describeSafeError(refused)).toBe('ECONNREFUSED');
    expect(describeSafeError(new Error('Failed query: select 1', { cause: refused }))).toBe(
      'Failed query: select 1 <- ECONNREFUSED',
    );
    expect(describeSafeError(new Error(''))).toBe('Error');
    expect(describeSafeError('texto')).toBe('texto');
  });
});
