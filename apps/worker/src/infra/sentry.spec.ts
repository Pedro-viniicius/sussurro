import * as Sentry from '@sentry/nestjs';
import { describe, expect, it } from 'vitest';

import { beforeSend, beforeSendSpan, buildSentryOptions } from './sentry.js';

const DSN = 'https://chavepublica123@o0.ingest.sentry.io/2';
const EXPO_TOKEN = 'ExponentPushToken[aparelho-do-worker-9]';
const FOLLOWER_ID = '01a189e0-af57-7000-85fe-2054e618fea6';

describe('buildSentryOptions (worker)', () => {
  it('CA1 (0.9): sem DSN não há opções (o SDK não é inicializado)', () => {
    expect(buildSentryOptions({})).toBeUndefined();
    expect(buildSentryOptions({ SENTRY_DSN: '' })).toBeUndefined();
    expect(buildSentryOptions({ SENTRY_DSN: '   ' })).toBeUndefined();
    expect(Sentry.getClient()).toBeUndefined();
  });

  it('[6.7 CA4] com DSN: release, ambiente, amostragem, sem PII e a limpeza no beforeSend', () => {
    const options = buildSentryOptions({
      SENTRY_DSN: DSN,
      SENTRY_ENVIRONMENT: 'production',
      SENTRY_RELEASE: 'abc1234',
      SENTRY_TRACES_SAMPLE_RATE: '0.05',
    });
    expect(options).toMatchObject({
      dsn: DSN,
      environment: 'production',
      release: 'abc1234',
      tracesSampleRate: 0.05,
      enableOpenTelemetrySetup: false,
      dataCollection: { userInfo: false, cookies: false, httpBodies: [], queues: false },
    });
    expect(options?.beforeSend).toBe(beforeSend);
    expect(options?.beforeSendSpan).toBe(beforeSendSpan);
  });
});

describe('evento do worker com transporte falso (PERM-17)', () => {
  it('[PERM-17] [6.7 CA2] push token e ids de relacionamento não chegam ao envelope', async () => {
    const envelopes: string[] = [];
    Sentry.init({
      ...buildSentryOptions({ SENTRY_DSN: DSN }),
      defaultIntegrations: false,
      enableRuntimeChannelInjection: false,
      transport: () => ({
        send: (envelope) => {
          envelopes.push(JSON.stringify(envelope));
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
    });
    Sentry.captureException(new Error(`Expo recusou ${EXPO_TOKEN}`), {
      tags: { queue: 'push' },
      extra: { message: { to: EXPO_TOKEN }, notification: { recipientId: FOLLOWER_ID } },
    });
    await Sentry.flush(2_000);
    const events = envelopes.filter((envelope) => envelope.includes('"type":"event"'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"queue":"push"');
    expect(events[0]).not.toContain(EXPO_TOKEN);
    expect(events[0]).not.toContain(FOLLOWER_ID);
    await Sentry.close();
  });
});
