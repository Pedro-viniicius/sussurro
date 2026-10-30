import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { createDb, eq, users } from '@sussurro/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { buildSentryOptions } from '../../infra/observability/sentry.js';
import { describeError } from '../errors/describe-error.js';

/**
 * PERM-17: o banco falha no meio de uma requisição (timeout, failover, lock) e o drizzle-orm embrulha
 * o erro do driver num `DrizzleQueryError` com os valores da consulta. Nenhum deles pode chegar ao
 * log nem ao Sentry. Valores fictícios.
 */
const VALUES = {
  email: 'ana.souza+teste@exemplo.com.br',
  hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsLWZpY3RpY2lv$aGFzaC1maWN0aWNpby1kZS10ZXN0ZQ', // gitleaks:allow
  name: 'Ana Souza Fictícia',
  // Bio com quebra de linha que imita um frame do stack.
  bio: 'minha bio\n    at frameFalsoDaBio (bio.js:1:1)',
};
const USER_ID = '01a189e0-af57-7000-85fe-2054e618fea6';
const SQLSTATE = '57014';
const DSN = 'https://chavepublica123@o0.ingest.sentry.io/1';

/** Partes que, se aparecerem em qualquer saída, são vazamento. */
function leaks(text: string): string[] {
  return Object.entries({
    email: VALUES.email,
    emailLocal: 'ana.souza+teste',
    hash: VALUES.hash,
    salt: 'c2FsLWZpY3RpY2lv',
    name: VALUES.name,
    bio: 'frameFalsoDaBio',
  })
    .filter(([, value]) => text.includes(value))
    .map(([key]) => key);
}

/** Erro do driver (`pg`) num timeout: `code` = SQLSTATE; o `detail` com valores nunca pode sair. */
function driverError(): Error {
  return Object.assign(new Error('canceling statement due to statement timeout'), {
    name: 'error',
    code: SQLSTATE,
    severity: 'ERROR',
    detail: `Key (email)=(${VALUES.email})`,
  });
}

/**
 * Um `DrizzleQueryError` de verdade: a consulta passa pelo drizzle-orm do `@sussurro/db` e o pool
 * do `pg` falha (o pool é preguiçoso: nenhuma conexão é aberta).
 */
async function realQueryError(): Promise<Error> {
  const handle = createDb('postgres://usuario@127.0.0.1:5432/sussurro_teste');
  vi.spyOn(handle.pool, 'query').mockRejectedValue(driverError());
  try {
    await handle.db
      .update(users)
      .set({ email: VALUES.email, passwordHash: VALUES.hash, name: VALUES.name, bio: VALUES.bio })
      .where(eq(users.id, USER_ID));
  } catch (error) {
    return error as Error;
  } finally {
    await handle.close();
  }
  throw new Error('a consulta deveria ter falhado');
}

function fakeHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('erro do banco no meio de uma requisição (PERM-17)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[PERM-17] controle: o DrizzleQueryError de verdade carrega e-mail, hash e nome', async () => {
    const error = await realQueryError();
    expect(error.constructor.name).toBe('DrizzleQueryError');
    expect(error).toHaveProperty('params');
    expect(leaks(`${error.message}\n${error.stack ?? ''}`)).toEqual(
      expect.arrayContaining(['email', 'hash', 'name']),
    );
  });

  it('[PERM-17] AllExceptionsFilter: log e envelope do Sentry sem os valores, com o SQLSTATE; o 500 não muda', async () => {
    const envelopes: string[] = [];
    Sentry.init({
      ...buildSentryOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'test' }),
      defaultIntegrations: false,
      // A cadeia de `cause` (o erro do driver) e as propriedades extras do erro vão ao evento.
      integrations: [Sentry.linkedErrorsIntegration(), Sentry.extraErrorDataIntegration()],
      enableRuntimeChannelInjection: false,
      transport: () => ({
        send: (envelope) => {
          envelopes.push(JSON.stringify(envelope));
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
    });
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const error = await realQueryError();
    const { host, status, json } = fakeHost();

    new AllExceptionsFilter().catch(error, host);
    await Sentry.flush(2_000);

    // Corpo do 500 igual ao de antes.
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ code: 'INTERNAL_ERROR', message: 'Erro interno' });

    // Log: o SQL, a mensagem e o SQLSTATE do driver e os frames; nada dos valores.
    expect(logged).toHaveBeenCalledTimes(1);
    const log = logged.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(log).toContain('Failed query: update "users" set');
    expect(log).toContain(`canceling statement due to statement timeout [${SQLSTATE}]`);
    expect(log).toMatch(/\n\s+at\s/);
    expect(log).not.toContain('params');
    expect(log).not.toContain('Key (email)');
    expect(leaks(log)).toEqual([]);

    // Sentry: um evento, com o erro limpo e a causa do driver.
    const events = envelopes.filter((envelope) => envelope.includes('"type":"event"'));
    expect(events).toHaveLength(1);
    const payload = events[0] ?? '';
    expect(payload).toContain('DrizzleQueryError');
    expect(payload).toContain(SQLSTATE);
    expect(payload).not.toContain('Key (email)');
    expect(leaks(envelopes.join('\n'))).toEqual([]);
    await Sentry.close();
  });

  it('[PERM-17] describeError (API): o SQL e o SQLSTATE, sem os valores', async () => {
    const text = describeError(await realQueryError());
    expect(text).toMatch(/^Failed query: update "users" set .* <- canceling statement/);
    expect(text).toContain(`[${SQLSTATE}]`);
    expect(text).not.toContain('params');
    expect(leaks(text)).toEqual([]);
  });
});
