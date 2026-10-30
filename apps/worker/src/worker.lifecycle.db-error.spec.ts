import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { createDb, eq, users } from '@sussurro/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from './config/config.module.js';
import type { Clock } from './infra/clock.js';
import { buildSentryOptions } from './infra/sentry.js';
import type { ObjectStorage } from './infra/storage.js';
import { runMaintenance } from './jobs/maintenance.js';
import type { MediaJobsConsumer } from './media/media-jobs.consumer.js';
import { checkPushReceipts } from './push/push-receipts.js';
import type { PushSender } from './push/push-sender.js';
import type { PushConsumer } from './push/push.consumer.js';
import { WorkerLifecycle } from './worker.lifecycle.js';

vi.mock('./jobs/maintenance.js', () => ({ runMaintenance: vi.fn() }));
vi.mock('./push/push-receipts.js', () => ({ checkPushReceipts: vi.fn() }));

/**
 * PERM-17: o job de manutenção e a consulta dos recibos do push falham no banco. O log e o Sentry
 * recebem a versão limpa do `DrizzleQueryError`, nunca os valores da consulta. Valores fictícios.
 */
const VALUES = {
  email: 'ana.souza+manutencao@mail.exemplo.com.br',
  hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsLW1hbnV0ZW5jYW8$aGFzaC1tYW51dGVuY2Fv', // gitleaks:allow
  name: 'Ana Souza Fictícia',
  bio: 'minha bio\n    at frameFalsoDaBio (bio.js:1:1)',
};
const USER_ID = '01a189e0-af57-7000-85fe-2054e618fea6';
const SQLSTATE = '40P01';
const DSN = 'https://chavepublica123@o0.ingest.sentry.io/4';

function leaks(text: string): string[] {
  return Object.entries({
    ...VALUES,
    emailLocal: 'ana.souza+manutencao',
    salt: 'c2FsLW1hbnV0ZW5jYW8',
    bio: 'frameFalsoDaBio',
    detail: 'Key (email)',
    params: 'params:',
  })
    .filter(([, value]) => text.includes(value))
    .map(([key]) => key);
}

/** Um `DrizzleQueryError` de verdade (drizzle-orm do `@sussurro/db`, pool do `pg` falhando). */
async function realQueryError(): Promise<Error> {
  const handle = createDb('postgres://usuario@127.0.0.1:5432/sussurro_teste');
  vi.spyOn(handle.pool, 'query').mockRejectedValue(
    Object.assign(new Error('deadlock detected'), {
      name: 'error',
      code: SQLSTATE,
      detail: `Key (email)=(${VALUES.email})`,
    }),
  );
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

function lifecycle(): WorkerLifecycle {
  const config = {
    env: {
      ACCOUNT_PURGE_AFTER_DAYS: 30,
      DRAFT_TTL_HOURS: 24,
      MEDIA_PROCESSING_TIMEOUT_MIN: 30,
    },
  } as unknown as WorkerConfig;
  const clock: Clock = { now: () => new Date('2026-10-30T12:00:00.000Z') };
  return new WorkerLifecycle(
    config,
    { db: {} as never, close: () => Promise.resolve() },
    { status: 'ready', quit: () => Promise.resolve('OK'), disconnect: () => undefined },
    {} as ObjectStorage,
    {} as MediaJobsConsumer,
    clock,
    null,
    {} as PushConsumer,
    {} as PushSender,
  );
}

const envelopes: string[] = [];

beforeAll(() => {
  Sentry.init({
    ...buildSentryOptions({ SENTRY_DSN: DSN }),
    defaultIntegrations: false,
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
});

afterAll(async () => {
  await Sentry.close();
});

beforeEach(() => {
  envelopes.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkerLifecycle com o banco falhando (PERM-17)', () => {
  it('[PERM-17] manutenção: log e evento do Sentry (tag job=maintenance) sem os valores, com o SQLSTATE', async () => {
    const error = await realQueryError();
    expect(leaks(`${error.message}\n${error.stack ?? ''}`)).toEqual(
      expect.arrayContaining(['email', 'hash', 'name']),
    );
    vi.mocked(runMaintenance).mockRejectedValue(error);
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await lifecycle().runMaintenanceNow();
    await Sentry.flush(2_000);

    expect(logged).toHaveBeenCalledTimes(1);
    const log = logged.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(log).toMatch(/^Falha na manutenção: Failed query: update "users" set /);
    expect(log).toContain(`deadlock detected [${SQLSTATE}]`);
    expect(leaks(log)).toEqual([]);

    const events = envelopes.filter((envelope) => envelope.includes('"type":"event"'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"job":"maintenance"');
    expect(events[0]).toContain('DrizzleQueryError');
    expect(events[0]).toContain(SQLSTATE);
    expect(leaks(envelopes.join('\n'))).toEqual([]);
  });

  it('[PERM-17] recibos do push: log e evento do Sentry (tag job=push-receipts) sem os valores', async () => {
    const error = await realQueryError();
    vi.mocked(checkPushReceipts).mockRejectedValue(error);
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await lifecycle().checkReceiptsNow();
    await Sentry.flush(2_000);

    expect(warned).toHaveBeenCalledTimes(1);
    const log = warned.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(log).toMatch(/^Falha ao consultar os recibos do push: Failed query: update "users"/);
    expect(log).toContain(`[${SQLSTATE}]`);
    expect(leaks(log)).toEqual([]);

    const events = envelopes.filter((envelope) => envelope.includes('"type":"event"'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"job":"push-receipts"');
    expect(events[0]).toContain(SQLSTATE);
    expect(leaks(envelopes.join('\n'))).toEqual([]);
  });
});
