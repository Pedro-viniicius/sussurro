import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { createDb, eq, users } from '@sussurro/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeError } from './describe-error.js';
import { QueueConsumer } from './queue-consumer.js';
import type { QueueMessage } from './queue.js';
import { buildSentryOptions } from './sentry.js';
import { InMemoryQueue } from '../testing/in-memory-queue.js';

/**
 * PERM-17: o banco falha enquanto o worker processa uma mensagem e o drizzle-orm embrulha o erro do
 * driver num `DrizzleQueryError` com os valores da consulta. Nenhum deles pode chegar ao log nem ao
 * Sentry. Valores fictícios.
 */
const VALUES = {
  email: 'ana.souza+teste@exemplo.com.br',
  hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsLWZpY3RpY2lv$aGFzaC1maWN0aWNpby1kZS10ZXN0ZQ', // gitleaks:allow
  name: 'Ana Souza Fictícia',
  // Bio com quebra de linha que imita um frame do stack.
  bio: 'minha bio\n    at frameFalsoDaBio (bio.js:1:1)',
};
const USER_ID = '01a189e0-af57-7000-85fe-2054e618fea6';
const SQLSTATE = '57P01';
const DSN = 'https://chavepublica123@o0.ingest.sentry.io/2';

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

/** Failover do banco: `code` = SQLSTATE; o `detail` com valores nunca pode sair. */
function driverError(): Error {
  return Object.assign(new Error('terminating connection due to administrator command'), {
    name: 'error',
    code: SQLSTATE,
    severity: 'FATAL',
    detail: `Key (email)=(${VALUES.email})`,
  });
}

/**
 * Um `DrizzleQueryError` de verdade: a consulta passa pelo drizzle-orm do `@sussurro/db` e o pool
 * do `pg` falha (o pool é preguiçoso: nenhuma conexão é aberta).
 */
async function failingUpdate(): Promise<never> {
  const handle = createDb('postgres://usuario@127.0.0.1:5432/sussurro_teste');
  vi.spyOn(handle.pool, 'query').mockRejectedValue(driverError());
  try {
    await handle.db
      .update(users)
      .set({ email: VALUES.email, passwordHash: VALUES.hash, name: VALUES.name, bio: VALUES.bio })
      .where(eq(users.id, USER_ID));
  } finally {
    await handle.close();
  }
  throw new Error('a consulta deveria ter falhado');
}

async function realQueryError(): Promise<Error> {
  try {
    return await failingUpdate();
  } catch (error) {
    return error as Error;
  }
}

/** Consumidor cujo processamento esbarra no banco fora. */
class FailingConsumer extends QueueConsumer {
  protected process(_message: QueueMessage): Promise<boolean> {
    return failingUpdate();
  }
}

describe('erro do banco no consumidor da fila (PERM-17)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[PERM-17] controle: o DrizzleQueryError de verdade carrega e-mail, hash e nome', async () => {
    const error = await realQueryError();
    expect(error.constructor.name).toBe('DrizzleQueryError');
    expect(leaks(`${error.message}\n${error.stack ?? ''}`)).toEqual(
      expect.arrayContaining(['email', 'hash', 'name']),
    );
  });

  it('[PERM-17] QueueConsumer: log e envelope do Sentry sem os valores, com o SQLSTATE; a mensagem volta para a fila', async () => {
    const envelopes: string[] = [];
    Sentry.init({
      ...buildSentryOptions({ SENTRY_DSN: DSN }),
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
    const queue = new InMemoryQueue();
    queue.send({ postId: USER_ID });
    const consumer = new FailingConsumer(
      queue,
      { concurrency: 1, waitTimeSeconds: 0, maxAttempts: 3 },
      'media-jobs',
    );

    expect(await consumer.pollOnce()).toBe(1);
    await Sentry.flush(2_000);

    // Não foi apagada: volta depois do visibility timeout.
    expect(queue.pending).toBe(1);

    expect(logged).toHaveBeenCalledTimes(1);
    const log = logged.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(log).toContain('Failed query: update "users" set');
    expect(log).toContain(`terminating connection due to administrator command [${SQLSTATE}]`);
    expect(log).not.toContain('params');
    expect(leaks(log)).toEqual([]);

    const events = envelopes.filter((envelope) => envelope.includes('"type":"event"'));
    expect(events).toHaveLength(1);
    const payload = events[0] ?? '';
    expect(payload).toContain('"queue":"media-jobs"');
    expect(payload).toContain('DrizzleQueryError');
    expect(payload).toContain(SQLSTATE);
    expect(payload).not.toContain('Key (email)');
    expect(leaks(envelopes.join('\n'))).toEqual([]);
    await Sentry.close();
  });

  it('[PERM-17] describeError (worker): o SQL e o SQLSTATE, sem os valores', async () => {
    const text = describeError(await realQueryError());
    expect(text).toMatch(/^Failed query: update "users" set .* <- terminating connection/);
    expect(text).toContain(`[${SQLSTATE}]`);
    expect(text).not.toContain('params');
    expect(leaks(text)).toEqual([]);
  });
});
