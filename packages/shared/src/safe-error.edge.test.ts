import { describe, expect, it } from 'vitest';

import { describeSafeError, SAFE_ERROR_MAX_CAUSE_DEPTH, sanitizeError } from './safe-error.ts';
import { scrubText, TELEMETRY_REDACTED } from './telemetry.ts';

/**
 * PERM-17, casos de borda do erro seguro (revisão do `testes`): cadeias longas de `cause`,
 * `AggregateError`, valores que não são `Error`, o `detail` do Postgres, e-mails e hashes em
 * outras formas e texto que imita um frame do stack. Valores fictícios.
 */
const VALUES = {
  email: 'ana.souza+teste@mail.exemplo.com.br',
  hashId: '$argon2id$v=19$m=19456,t=2,p=1$c2FsLWZpY3RpY2lv$aGFzaC1maWN0aWNpby1kZS10ZXN0ZQ', // gitleaks:allow
  hashI: '$argon2i$v=19$m=4096,t=3,p=1$c2FsLWFyZ29uMmk$aGFzaC1hcmdvbjJpLWZpY3RpY2lv', // gitleaks:allow
  hashD: '$argon2d$v=19$m=4096,t=3,p=1$c2FsLWFyZ29uMmQ$aGFzaC1hcmdvbjJkLWZpY3RpY2lv', // gitleaks:allow
  name: 'Ana Souza Fictícia',
  bio: 'minha bio\n    at frameFalsoDaBio (bio.js:1:1)',
};

/** Pedaços que, em qualquer saída, são vazamento. */
const NEEDLES: Record<string, string> = {
  email: VALUES.email,
  emailLocal: 'ana.souza+teste',
  hashId: VALUES.hashId,
  hashI: VALUES.hashI,
  hashD: VALUES.hashD,
  saltId: 'c2FsLWZpY3RpY2lv',
  saltI: 'c2FsLWFyZ29uMmk',
  saltD: 'c2FsLWFyZ29uMmQ',
  name: VALUES.name,
  bio: 'frameFalsoDaBio',
  detail: 'Failing row contains',
};

function leaks(text: string): string[] {
  return Object.entries(NEEDLES)
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name);
}

/** Tudo o que um log ou o Sentry poderiam ler do erro limpo, em todos os níveis. */
function everything(error: Error): string {
  const parts: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    parts.push(current.name, current.message, current.stack ?? '', JSON.stringify(current));
    parts.push(JSON.stringify(Object.getOwnPropertyNames(current)));
  }
  return parts.join('\n');
}

function chain(error: Error): Error[] {
  const result: Error[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    result.push(current);
  }
  return result;
}

const SQL = 'update "users" set "email" = $1, "password_hash" = $2, "name" = $3, "bio" = $4';

/** Mesma forma do `DrizzleQueryError` do drizzle-orm 0.45. */
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

/**
 * Erro do driver como o `pg` e o PGlite entregam numa CHECK violada: o `detail` traz a linha
 * inteira (e-mail, hash e nome), e há `where`, `table`, `constraint` e `schema`.
 */
function checkViolation(): Error {
  return Object.assign(
    new Error('new row for relation "users" violates check constraint "users_bio_check"'),
    {
      name: 'error',
      code: '23514',
      severity: 'ERROR',
      detail: `Failing row contains (01a1, ${VALUES.email}, ${VALUES.hashId}, ${VALUES.name}).`,
      hint: `confira ${VALUES.email}`,
      where: `PL/pgSQL function x() line 3 at RAISE: ${VALUES.name}`,
      internalQuery: `select '${VALUES.email}'`,
      schema: 'public',
      table: 'users',
      constraint: 'users_bio_check',
    },
  );
}

function queryError(cause: Error = checkViolation()): DrizzleQueryError {
  return new DrizzleQueryError(SQL, [VALUES.email, VALUES.hashId, VALUES.name, VALUES.bio], cause);
}

describe('sanitizeError: cadeia de cause (PERM-17)', () => {
  it('[PERM-17] DrizzleQueryError no cause do cause: limpo em todos os níveis, com o SQLSTATE no fim', () => {
    const original = new Error('falha ao salvar o perfil', {
      cause: new Error('transação desfeita', { cause: queryError() }),
    });
    const safe = sanitizeError(original);
    const levels = chain(safe);
    expect(levels.map((level) => level.name)).toEqual([
      'Error',
      'Error',
      'DrizzleQueryError',
      'error',
    ]);
    expect(levels[2]?.message).toBe(`Failed query: ${SQL}`);
    expect(levels[3]?.message).toBe(
      'new row for relation "users" violates check constraint "users_bio_check" [23514]',
    );
    expect((levels[3] as Error & { code?: string }).code).toBe('23514');
    expect(leaks(everything(safe))).toEqual([]);
    expect(describeSafeError(original)).toBe(
      `falha ao salvar o perfil <- transação desfeita <- Failed query: ${SQL} <- ` +
        'new row for relation "users" violates check constraint "users_bio_check" [23514]',
    );
  });

  it('[PERM-17] DrizzleQueryError no último nível permitido é limpo; abaixo do limite, nada sai', () => {
    // O erro de cima + SAFE_ERROR_MAX_CAUSE_DEPTH níveis: o DrizzleQueryError é o último.
    let atLimit: Error = queryError();
    for (let level = 0; level < SAFE_ERROR_MAX_CAUSE_DEPTH; level += 1) {
      atLimit = new Error(`nível ${String(level)}`, { cause: atLimit });
    }
    const safeAtLimit = sanitizeError(atLimit);
    expect(chain(safeAtLimit)).toHaveLength(SAFE_ERROR_MAX_CAUSE_DEPTH + 1);
    expect(chain(safeAtLimit).at(-1)?.name).toBe('DrizzleQueryError');
    expect(leaks(everything(safeAtLimit))).toEqual([]);

    // Um nível a mais: o DrizzleQueryError (e o driver) ficam de fora, sem vazar.
    const beyond = new Error('mais um nível', { cause: atLimit });
    const safeBeyond = sanitizeError(beyond);
    expect(chain(safeBeyond)).toHaveLength(SAFE_ERROR_MAX_CAUSE_DEPTH + 1);
    expect(leaks(everything(safeBeyond))).toEqual([]);
    expect(leaks(describeSafeError(beyond, { withStack: true }))).toEqual([]);
  });

  it('[PERM-17] cause que não é Error (texto e objeto) também sai limpo', () => {
    const withText = new Error('falhou', { cause: `params: ${VALUES.name}, ${VALUES.email}` });
    const withObject = new Error('falhou', {
      cause: { message: `valor ${VALUES.email}`, detail: VALUES.name, params: [VALUES.hashI] },
    });
    for (const original of [withText, withObject]) {
      const safe = sanitizeError(original);
      expect(leaks(everything(safe))).toEqual([]);
      expect(leaks(describeSafeError(original))).toEqual([]);
    }
    expect(describeSafeError(withText)).toBe(`falhou <- params: ${TELEMETRY_REDACTED}`);
    expect(describeSafeError(withObject)).toBe(`falhou <- valor ${TELEMETRY_REDACTED}`);
  });
});

describe('sanitizeError: AggregateError (PERM-17)', () => {
  it('[PERM-17] os `errors` (com DrizzleQueryError dentro) não saem; a mensagem passa pelo scrub', () => {
    const aggregate = new AggregateError(
      [queryError(), new Error(`falhou para ${VALUES.name}`)],
      `2 falhas para ${VALUES.email}`,
    );
    const safe = sanitizeError(aggregate);
    expect(safe.name).toBe('AggregateError');
    expect(safe.message).toBe(`2 falhas para ${TELEMETRY_REDACTED}`);
    expect(safe).not.toHaveProperty('errors');
    expect(leaks(everything(safe))).toEqual([]);
    expect(leaks(describeSafeError(aggregate, { withStack: true }))).toEqual([]);
  });

  it('[PERM-17] AggregateError sem mensagem (ECONNREFUSED do Windows) vira o código', () => {
    const refused = Object.assign(
      new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:5432')], ''),
      { code: 'ECONNREFUSED' },
    );
    const safe = sanitizeError(refused);
    expect(safe.message).toBe('ECONNREFUSED');
    expect(safe.code).toBe('ECONNREFUSED');
    expect(describeSafeError(new Error('Failed query: select 1', { cause: refused }))).toBe(
      'Failed query: select 1 <- ECONNREFUSED',
    );
  });
});

describe('sanitizeError: valor que não é Error (PERM-17)', () => {
  it('[PERM-17] texto, objeto parecido com erro, objeto com toString e primitivos', () => {
    const cases: [unknown, string][] = [
      [
        `falhou ${VALUES.email} ${VALUES.hashI}`,
        `falhou ${TELEMETRY_REDACTED} ${TELEMETRY_REDACTED}`,
      ],
      [
        { message: `msg ${VALUES.email}`, detail: VALUES.name, params: [VALUES.name], code: 'E1' },
        `msg ${TELEMETRY_REDACTED} [E1]`,
      ],
      [{ message: 'sem query', query: 42, params: [VALUES.name] }, 'sem query'],
      [{ detail: VALUES.name, params: [VALUES.email] }, '[object Object]'],
      [{ toString: () => `texto ${VALUES.email}` }, `texto ${TELEMETRY_REDACTED}`],
      [42, '42'],
      [null, 'null'],
      [Symbol('s'), 'Symbol(s)'],
    ];
    for (const [input, expected] of cases) {
      const safe = sanitizeError(input);
      expect(safe).toBeInstanceOf(Error);
      expect(safe.message).toBe(expected);
      expect(leaks(everything(safe))).toEqual([]);
      expect(describeSafeError(input)).toBe(expected);
    }
  });

  it('[PERM-17] objeto com a forma do DrizzleQueryError (sem ser Error): só o SQL e os frames reais', () => {
    const message = `Failed query: ${SQL}\nparams: ${VALUES.email},${VALUES.name},${VALUES.bio}`;
    const shaped = {
      message,
      query: SQL,
      params: [VALUES.email, VALUES.name, VALUES.bio],
      stack: `Error: ${message}\n    at realFrame (app.js:10:5)`,
    };
    const safe = sanitizeError(shaped);
    expect(safe.name).toBe('DrizzleQueryError');
    expect(safe.message).toBe(`Failed query: ${SQL}`);
    // O frame imitado pela bio (último param) está colado nos frames reais: sai com a mensagem.
    expect(safe.stack).toBe(
      `DrizzleQueryError: Failed query: ${SQL}\n    at realFrame (app.js:10:5)`,
    );
    expect(leaks(everything(safe))).toEqual([]);
  });
});

describe('sanitizeError: detail e campos extras do Postgres (PERM-17)', () => {
  it('[PERM-17] detail, hint, where e internalQuery nunca saem; SQLSTATE fica na mensagem e no code', () => {
    const safe = sanitizeError(checkViolation());
    expect(safe.message).toBe(
      'new row for relation "users" violates check constraint "users_bio_check" [23514]',
    );
    expect(safe.code).toBe('23514');
    for (const field of ['detail', 'hint', 'where', 'internalQuery', 'severity', 'table']) {
      expect(safe).not.toHaveProperty(field);
    }
    expect(leaks(everything(safe))).toEqual([]);
  });

  it('[PERM-17] detail do 23505 (Key (email)=(…)) também não sai pelo DrizzleQueryError', () => {
    const unique = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_key"'),
      { code: '23505', detail: `Key (email)=(${VALUES.email}) already exists.` },
    );
    const safe = sanitizeError(queryError(unique));
    expect(chain(safe).map((level) => level.message)).toEqual([
      `Failed query: ${SQL}`,
      'duplicate key value violates unique constraint "users_email_key" [23505]',
    ]);
    expect(leaks(everything(safe))).toEqual([]);
    expect(everything(safe)).not.toContain('Key (email)');
  });
});

describe('sanitizeError: stack (PERM-17)', () => {
  it('[PERM-17] frame imitado num erro comum: o stack limpo tem só os frames de verdade', () => {
    const original = new Error(`perfil: ${VALUES.bio}`);
    const safe = sanitizeError(original);
    // A mensagem é o texto (pode ter o frame imitado), mas os frames vêm só do fim do stack.
    const header = `${safe.name}: ${safe.message}`;
    expect(safe.stack?.startsWith(header)).toBe(true);
    const frames = (safe.stack ?? '').slice(header.length).split('\n').filter(Boolean);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((line) => /^\s+at\s/.test(line))).toBe(true);
    expect(frames.some((line) => line.includes('frameFalsoDaBio'))).toBe(false);
    const describeLines = describeSafeError(original, { withStack: true }).split('\n');
    expect(describeLines.filter((line) => line.includes('frameFalsoDaBio'))).toHaveLength(1);
  });

  it('[PERM-17] o caminho útil do stack continua: o frame deste arquivo, com linha e coluna', () => {
    const safe = sanitizeError(queryError());
    expect(safe.stack).toMatch(/\n\s+at .*safe-error\.edge\.test\.ts:\d+:\d+/);
    const logged = describeSafeError(queryError(), { withStack: true });
    expect(logged).toMatch(/\n\s+at .*safe-error\.edge\.test\.ts:\d+:\d+/);
    expect(logged.split('\n')[0]).toContain('[23514]');
  });
});

describe('scrubText: formas de e-mail, hash e params (PERM-17)', () => {
  it('[PERM-17] e-mail com +, subdomínios, maiúsculas e acento vira [Filtered] inteiro', () => {
    for (const email of [
      'ana.souza+teste@mail.exemplo.com.br',
      'a.b+c@sub.dom.example.co.uk',
      'JOAO.SILVA@EXEMPLO.COM',
      'joão_d-silva@exemplo.org',
      "o'neil@x.io",
    ]) {
      expect(scrubText(`para ${email}, fim`)).toBe(`para ${TELEMETRY_REDACTED}, fim`);
    }
  });

  it('[PERM-17] hash argon2i, argon2d e sem a versão viram [Filtered]', () => {
    for (const hash of [
      VALUES.hashId,
      VALUES.hashI,
      VALUES.hashD,
      '$argon2id$m=65536,t=3,p=4$c2FsdA$aGFzaA', // gitleaks:allow
    ]) {
      expect(scrubText(`h=${hash};`)).toBe(`h=${TELEMETRY_REDACTED};`);
    }
  });

  it('[PERM-17] params: depois de \\r\\n e no texto escapado de uma linha de log em JSON', () => {
    expect(scrubText(`Failed query: select $1\r\nparams: ${VALUES.name}`)).toBe(
      `Failed query: select $1\r\nparams: ${TELEMETRY_REDACTED}`,
    );
    const jsonLine = JSON.stringify({ msg: `Failed query: select $1\nparams: ${VALUES.name}` });
    expect(leaks(scrubText(jsonLine))).toEqual([]);
  });
});
