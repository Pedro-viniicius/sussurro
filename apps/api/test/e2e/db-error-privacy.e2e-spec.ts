// PERM-17b (e2e): o banco falha DE VERDADE (PGlite, sem mock do driver) no meio de rotas que recebem
// e-mail, senha, nome e bio. O drizzle-orm embrulha o erro num `DrizzleQueryError` com os valores
// da consulta, e o erro do driver traz o `detail` do Postgres (numa CHECK violada, a linha inteira:
// e-mail, hash da senha, nome, bio). O log (o pino de produção, no nível `trace`, gravado num stream
// do teste) e o Sentry (as opções de produção, com as integrações padrão e um transporte falso) não
// podem conter nenhum desses valores; o corpo do 500 é o de sempre. Valores fictícios.
import * as Sentry from '@sentry/nestjs';
import { eq, sql, users } from '@sussurro/db';
import { createUser, TEST_PASSWORD, TEST_PASSWORD_HASH } from '@sussurro/db/testing';
import { AuthSessionSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildSentryOptions } from '../../src/infra/observability/sentry.js';
import { bearer } from '../support/auth.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const DSN = 'https://chavepublica123@o0.ingest.sentry.io/17';

/** Quem se cadastra (fictício). */
const PERSON = {
  email: 'ana.souza+perm17@mail.exemplo.com.br',
  password: 'senha-ficticia-perm17-42', // gitleaks:allow (fictícia, só de teste)
  handle: 'ana_perm17',
  name: 'Ana Souza Fictícia',
  // Bio com quebra de linha que imita um frame do stack.
  bio: 'minha bio\n    at frameFalsoDaBio (bio.js:1:1)',
};

/** O corpo de todo 500 (fase-0-plano.md §6.3): igual com ou sem a falha do banco. */
const INTERNAL_ERROR = { code: 'INTERNAL_ERROR', message: 'Erro interno' };

let t: TestApp;
const logLines: string[] = [];
const envelopes: string[] = [];

interface LogEntry {
  level: number;
  msg?: string;
  context?: string;
  [key: string]: unknown;
}

/** Pedaços que, em qualquer saída, são vazamento. */
function needles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    email: PERSON.email,
    emailLocal: 'ana.souza+perm17',
    emailDomain: 'mail.exemplo.com.br',
    password: PERSON.password,
    testPassword: TEST_PASSWORD,
    testHash: TEST_PASSWORD_HASH,
    name: PERSON.name,
    bio: 'frameFalsoDaBio',
    argon2: '$argon2',
    detail: 'Failing row contains',
    params: 'params:',
    ...extra,
  };
}

function leaks(text: string, extra: Record<string, string> = {}): string[] {
  return Object.entries(needles(extra))
    .filter(([, value]) => text.includes(value))
    .map(([key]) => key);
}

/** O que saiu da requisição: as linhas do log, o texto do log e os eventos do Sentry. */
async function collect() {
  await Sentry.flush(2_000);
  const entries = logLines.map((line) => JSON.parse(line) as LogEntry);
  const events = envelopes.filter((envelope) => envelope.includes('"type":"event"'));
  return {
    entries,
    log: logLines.join(''),
    // O texto já decodificado das mensagens (o JSON escapa a quebra de linha).
    messages: entries.map((entry) => entry.msg ?? '').join('\n'),
    events,
    sentry: envelopes.join('\n'),
  };
}

/** A linha de erro do filtro (há uma só por 500). */
function filterError(entries: LogEntry[]): LogEntry {
  const errors = entries.filter(
    (entry) => entry.context === 'AllExceptionsFilter' && entry.level >= 50,
  );
  const [line] = errors;
  expect(errors).toHaveLength(1);
  if (line === undefined) {
    throw new Error('o filtro não registrou o erro');
  }
  return line;
}

/** DDL só deste banco de teste (PGlite em memória, um por arquivo). */
async function ddl(statement: string): Promise<void> {
  await t.database.db.execute(sql.raw(statement));
}

/** Controle: a consulta falha de verdade e o erro original carrega os valores. */
async function originalError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('a consulta deveria ter falhado');
}

function causeDetail(error: Error): string {
  const { detail } = (error.cause ?? {}) as { detail?: unknown };
  return typeof detail === 'string' ? detail : '';
}

beforeAll(async () => {
  Sentry.init({
    ...buildSentryOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'test' }),
    // As integrações padrão de produção, mais a que copia as propriedades extras do erro para o
    // evento (se o erro original chegasse ao SDK, `params`, `query` e `detail` apareceriam).
    integrations: (defaults) => [...defaults, Sentry.extraErrorDataIntegration({ depth: 5 })],
    enableRuntimeChannelInjection: false,
    transport: () => ({
      send: (envelope) => {
        envelopes.push(JSON.stringify(envelope));
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  });
  t = await createTestApp({
    env: { LOG_LEVEL: 'trace' },
    logStream: {
      write: (line: string) => {
        logLines.push(line);
      },
    },
  });
});

afterAll(async () => {
  await t.app.close();
  try {
    await t.database.close();
  } catch {
    // O último teste derruba o PGlite de propósito (conexão perdida): fechar de novo pode falhar.
  }
  await Sentry.close();
});

beforeEach(async () => {
  await t.reset();
  // Um evento ainda na fila de um teste anterior não pode cair na conta deste.
  await Sentry.flush(2_000);
  logLines.length = 0;
  envelopes.length = 0;
});

describe('erro real do banco no meio de uma rota (PERM-17b)', () => {
  it('[PERM-17b] POST /auth/register com CHECK violada no INSERT (23514): 500 de sempre; log e Sentry sem e-mail, senha, hash e nome', async () => {
    await ddl(
      `ALTER TABLE users ADD CONSTRAINT qa_perm17_cadastro CHECK (email NOT LIKE '%@mail.exemplo.com.br')`,
    );
    try {
      // Controle: o erro do banco carrega o e-mail na mensagem (params) e no detail (a linha).
      const control = await originalError(() =>
        t.database.db.insert(users).values({
          email: PERSON.email,
          passwordHash: TEST_PASSWORD_HASH,
          handle: PERSON.handle,
          name: PERSON.name,
          accountType: 'personal',
        }),
      );
      expect(control.constructor.name).toBe('DrizzleQueryError');
      expect(control.message).toContain(PERSON.email);
      expect(causeDetail(control)).toContain(PERSON.email);
      // O Postgres corta cada valor longo do detail em ~30 caracteres (com `...`).
      expect(causeDetail(control)).toContain(TEST_PASSWORD_HASH.slice(0, 40));

      const response = await t.http
        .post('/v1/auth/register')
        .send({
          email: PERSON.email,
          password: PERSON.password,
          handle: PERSON.handle,
          name: PERSON.name,
        })
        .expect(500);
      expect(response.body).toEqual(INTERNAL_ERROR);
      expect(leaks(JSON.stringify(response.headers))).toEqual([]);
    } finally {
      await ddl('ALTER TABLE users DROP CONSTRAINT qa_perm17_cadastro');
    }

    const { entries, log, messages, events, sentry } = await collect();
    // Log: o SQL, a mensagem e o SQLSTATE do driver e o caminho do stack; nada dos valores.
    const line = filterError(entries);
    expect(line.msg).toMatch(/^Failed query: insert into "users" /);
    // O SQLSTATE fica. (Com o `pg`, a mensagem do driver também; o erro do PGlite tem `query` e
    // `params` e por isso também vira só `Failed query: <sql> [23514]`.)
    expect(line.msg).toContain('[23514]');
    // O caminho útil do stack: o repositório e o serviço do cadastro, com linha e coluna.
    expect(line.msg).toMatch(
      /\n\s+at .*apps\/api\/src\/modules\/auth\/credentials\.repository\.ts:\d+:\d+/,
    );
    expect(line.msg).toMatch(/\n\s+at .*apps\/api\/src\/modules\/auth\/auth\.service\.ts:\d+:\d+/);
    expect(leaks(log)).toEqual([]);
    expect(leaks(messages)).toEqual([]);

    // Sentry: um evento, com o erro limpo, a causa do driver e o SQLSTATE.
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('DrizzleQueryError');
    expect(events[0]).toContain('23514');
    // A rota e o método ficam no evento (é o que agrupa no Sentry); o corpo não.
    expect(events[0]).toContain('POST /v1/auth/register');
    expect(leaks(sentry)).toEqual([]);
  });

  it('[PERM-17b] PATCH /me com bio que imita um frame e CHECK violada (detail com a linha inteira da conta): log e Sentry limpos', async () => {
    const registered = await t.http
      .post('/v1/auth/register')
      .send({
        email: PERSON.email,
        password: PERSON.password,
        handle: PERSON.handle,
        name: 'Nome Antigo',
      })
      .expect(201);
    const session = AuthSessionSchema.parse(registered.body);
    // O hash de verdade da senha (argon2id com sal aleatório), lido do banco.
    const [row] = await t.database.db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, session.user.id));
    const hash = row?.hash ?? '';
    expect(hash).toMatch(/^\$argon2id\$/);
    const extra = {
      realHash: hash,
      realSalt: hash.split('$')[4] ?? hash,
      // O PATCH vai com o Bearer: nem ele nem o refresh podem aparecer.
      accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
    };

    await ddl(
      `ALTER TABLE users ADD CONSTRAINT qa_perm17_bio CHECK (bio IS NULL OR bio NOT LIKE '%frameFalsoDaBio%')`,
    );
    try {
      logLines.length = 0;
      envelopes.length = 0;
      const response = await t.http
        .patch('/v1/me')
        .set(bearer(session.tokens.accessToken))
        .send({ name: PERSON.name, bio: PERSON.bio })
        .expect(500);
      expect(response.body).toEqual(INTERNAL_ERROR);

      // Controle: o detail do Postgres traz e-mail e hash da conta, que nem estavam na consulta.
      const control = await originalError(() =>
        t.database.db.update(users).set({ bio: PERSON.bio }).where(eq(users.id, session.user.id)),
      );
      expect(causeDetail(control)).toContain(PERSON.email);
      expect(causeDetail(control)).toContain(hash.slice(0, 40));
      expect(causeDetail(control)).toContain('frameFalsoDaBio');
    } finally {
      await ddl('ALTER TABLE users DROP CONSTRAINT qa_perm17_bio');
    }

    const { entries, log, messages, events, sentry } = await collect();
    const line = filterError(entries);
    expect(line.msg).toMatch(/^Failed query: update "users" set /);
    expect(line.msg).toContain('[23514]');
    // Os frames são os de verdade: nenhum veio da bio.
    const frames = (line.msg ?? '').split('\n').slice(1);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => /^\s+at\s/.test(frame))).toBe(true);
    expect(line.msg).toMatch(/\n\s+at .*apps\/api\/src\/modules\/users\/[\w.-]+\.ts:\d+:\d+/);
    expect(leaks(log, extra)).toEqual([]);
    expect(leaks(messages, extra)).toEqual([]);

    expect(events).toHaveLength(1);
    expect(events[0]).toContain('DrizzleQueryError');
    expect(events[0]).toContain('23514');
    expect(leaks(sentry, extra)).toEqual([]);
  });

  it('[PERM-17b] POST /auth/login com a coluna fora (42703): 500 de sempre; o e-mail e a senha não saem', async () => {
    await createUser(t.database.db, {
      email: PERSON.email,
      handle: PERSON.handle,
      name: PERSON.name,
    });
    await ddl('ALTER TABLE users RENAME COLUMN email TO email_perm17');
    try {
      const response = await t.http
        .post('/v1/auth/login')
        .send({ email: PERSON.email, password: TEST_PASSWORD })
        .expect(500);
      expect(response.body).toEqual(INTERNAL_ERROR);
    } finally {
      await ddl('ALTER TABLE users RENAME COLUMN email_perm17 TO email');
    }

    const { entries, log, messages, events, sentry } = await collect();
    const line = filterError(entries);
    expect(line.msg).toMatch(/^Failed query: select /);
    expect(line.msg).toContain('[42703]');
    expect(line.msg).toMatch(/\n\s+at .*apps\/api\/src\/modules\/auth\/[\w.-]+\.ts:\d+:\d+/);
    expect(leaks(log)).toEqual([]);
    expect(leaks(messages)).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('42703');
    expect(leaks(sentry)).toEqual([]);
  });

  // Por último: derruba o banco (o PGlite fecha) e não há volta neste arquivo.
  it('[PERM-17b] POST /auth/login com o banco derrubado no meio: 500 de sempre; o e-mail e a senha não saem', async () => {
    await createUser(t.database.db, { email: PERSON.email, handle: PERSON.handle });
    const client = (t.database.db as unknown as { $client: { close: () => Promise<void> } })
      .$client;
    await client.close();

    const response = await t.http
      .post('/v1/auth/login')
      .send({ email: PERSON.email, password: TEST_PASSWORD })
      .expect(500);
    expect(response.body).toEqual(INTERNAL_ERROR);

    const { entries, log, messages, events, sentry } = await collect();
    const line = filterError(entries);
    expect(line.msg).toMatch(/^Failed query: select .* <- PGlite is closed/);
    expect(leaks(log)).toEqual([]);
    expect(leaks(messages)).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('DrizzleQueryError');
    expect(leaks(sentry)).toEqual([]);
  });
});
