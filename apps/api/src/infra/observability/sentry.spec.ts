import * as Sentry from '@sentry/nestjs';
import { ErrorCode } from '@sussurro/shared';
import { describe, expect, it } from 'vitest';

import { beforeSend, beforeSendSpan, buildSentryOptions, isExpectedUnavailable } from './sentry.js';
import { DomainError } from '../../common/errors/domain-error.js';

const DSN = 'https://chavepublica123@o0.ingest.sentry.io/1';

/** Valores que nunca podem chegar ao Sentry (PERM-17, 6.7 CA1 e CA2). */
const SECRETS = {
  authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.YXNzaW5hdHVyYS1kby1qd3Q',
  cookie: 'sid=cookie-da-sessao-123',
  password: 'senha-que-nunca-sai-42',
  token: 'link-de-email-opaco-999',
  refreshToken: 'refresh-opaco-de-256-bits',
  observedToken: 'AAECAwQFBgcICQoLDA0ODw',
  targetToken: 'EBESExQVFhcYGRobHB0eHw',
  expoToken: 'ExponentPushToken[aparelho-secreto-77]',
  followerId: '01a189e0-af57-7000-85fe-2054e618fea6',
  creatorId: '01a189e0-af57-7000-85fe-2054e618fea7',
  canary: 'canary_conn_sentry1',
  ip: '198.51.100.23',
};

function leaks(payload: string): string[] {
  return Object.entries(SECRETS)
    .filter(([, value]) => payload.includes(value))
    .map(([name]) => name);
}

describe('Sentry sem DSN (D4)', () => {
  it('CA1 (0.9): sem DSN não há opções e o SDK não é inicializado: nada é enviado', () => {
    expect(buildSentryOptions({})).toBeUndefined();
    expect(buildSentryOptions({ SENTRY_DSN: '' })).toBeUndefined();
    expect(buildSentryOptions({ SENTRY_DSN: '   ' })).toBeUndefined();
    // Sem `init`, não existe cliente nem transporte (as capturas não vão a lugar nenhum).
    expect(Sentry.getClient()).toBeUndefined();
    Sentry.captureException(new Error('sem DSN'));
    expect(Sentry.getClient()).toBeUndefined();
  });
});

describe('buildSentryOptions (6.7)', () => {
  it('[6.7 CA4] com DSN: release, ambiente, amostragem e o equivalente a sendDefaultPii: false', () => {
    const options = buildSentryOptions({
      SENTRY_DSN: DSN,
      SENTRY_ENVIRONMENT: 'preview',
      SENTRY_RELEASE: 'abc1234',
      SENTRY_TRACES_SAMPLE_RATE: '0.2',
    });
    expect(options).toMatchObject({
      dsn: DSN,
      environment: 'preview',
      release: 'abc1234',
      tracesSampleRate: 0.2,
      includeLocalVariables: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        queues: false,
      },
    });
    expect(options?.beforeSend).toBe(beforeSend);
    expect(options?.beforeSendSpan).toBe(beforeSendSpan);
  });

  it('padrões: ambiente local, sem release (o SDK descobre) e amostragem inválida = 0', () => {
    const options = buildSentryOptions({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: 'muito' });
    expect(options).toMatchObject({ environment: 'local', tracesSampleRate: 0 });
    expect(options).not.toHaveProperty('release');
    expect(buildSentryOptions({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '7' })).toMatchObject({
      tracesSampleRate: 1,
    });
  });

  it('PROXIMITY_UNAVAILABLE é esperado (fica fora do Sentry); outros 5xx não', () => {
    expect(
      isExpectedUnavailable(new DomainError(ErrorCode.PROXIMITY_UNAVAILABLE, 503, 'Valkey fora')),
    ).toBe(true);
    expect(isExpectedUnavailable(new DomainError(ErrorCode.SERVICE_UNAVAILABLE, 503))).toBe(false);
    expect(isExpectedUnavailable(new Error('boom'))).toBe(false);
    expect(isExpectedUnavailable(undefined)).toBe(false);
  });
});

describe('evento enviado pelo SDK, com transporte falso (PERM-17)', () => {
  it('[PERM-17] [6.7 CA1] [6.7 CA2] nenhum valor sensível nem relacionamento chega ao envelope; 503 de proximidade não é enviado', async () => {
    const envelopes: string[] = [];
    const options = buildSentryOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'test' });
    Sentry.init({
      ...options,
      defaultIntegrations: false,
      integrations: [Sentry.requestDataIntegration()],
      enableRuntimeChannelInjection: false,
      transport: () => ({
        send: (envelope) => {
          envelopes.push(JSON.stringify(envelope));
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
    });

    Sentry.withIsolationScope((scope) => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          method: 'POST',
          url: `https://api.sussurro.app/v1/connections/requests?token=${SECRETS.token}`,
          query_string: `token=${SECRETS.token}`,
          headers: {
            authorization: SECRETS.authorization,
            cookie: SECRETS.cookie,
            'x-forwarded-for': SECRETS.ip,
            'user-agent': 'okhttp/5',
          },
          cookies: { sid: SECRETS.cookie },
          data: {
            password: SECRETS.password,
            observedToken: SECRETS.observedToken,
            targetToken: SECRETS.targetToken,
          },
        },
      });
      scope.setUser({ id: SECRETS.followerId, ip_address: SECRETS.ip });
      Sentry.captureException(
        new Error(`Key (follower_id, creator_id)=(${SECRETS.followerId}, ${SECRETS.creatorId})`),
        {
          extra: {
            body: {
              password: SECRETS.password,
              refreshToken: SECRETS.refreshToken,
              expoToken: SECRETS.expoToken,
            },
            followers: [{ handle: SECRETS.canary }],
            pair: { followerId: SECRETS.followerId, creatorId: SECRETS.creatorId },
            note: `push para ${SECRETS.expoToken}`,
          },
        },
      );
      Sentry.captureException(
        new DomainError(ErrorCode.PROXIMITY_UNAVAILABLE, 503, 'Valkey fora (esperado)'),
      );
    });
    await Sentry.flush(2_000);

    // Controle positivo: só o erro inesperado virou evento (com a rota sem a query); o outro
    // envelope, se houver, é o relatório do cliente ("1 evento descartado"), sem dados.
    const events = envelopes.filter((envelope) => envelope.includes('"type":"event"'));
    expect(events).toHaveLength(1);
    const payload = events[0] ?? '';
    expect(payload).toContain('Key (follower_id, creator_id)=([Filtered])');
    expect(payload).toContain('https://api.sussurro.app/v1/connections/requests');
    expect(payload).toContain('okhttp/5');
    const everything = envelopes.join('\n');
    expect(everything).not.toContain('Valkey fora (esperado)');
    expect(leaks(everything)).toEqual([]);
    await Sentry.close();
  });
});
