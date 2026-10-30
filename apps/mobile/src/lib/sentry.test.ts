jest.mock('@sentry/react-native', () => ({ init: jest.fn(), captureException: jest.fn() }));
jest.mock('expo-constants', () => ({ expoConfig: { extra: { appVariant: 'preview' } } }));

import type { ReactNativeOptions } from '@sentry/react-native';

import type * as SentryModule from './sentry';

type Module = typeof SentryModule;

/** Módulo novo a cada teste: o `initialized` interno não vaza entre os casos. */
function load(): Module & { init: jest.Mock } {
  jest.resetModules();
  const module = jest.requireActual<Module>('./sentry');
  const { init } = jest.requireMock<{ init: jest.Mock }>('@sentry/react-native');
  return { ...module, init };
}

const DSN = 'https://chave@o0.ingest.sentry.io/1';

/** As opções que o app passou ao `Sentry.init`. */
function initOptions(init: jest.Mock): ReactNativeOptions {
  return init.mock.calls[0]?.[0] as ReactNativeOptions;
}

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMWExODllMCJ9.c2VncmVkby1kby1zZXJ2aWRvcg';
const PUSH_TOKEN = 'ExponentPushToken[abcdefghijklmnop]';

/** Um evento de erro com tudo o que nunca pode sair do aparelho (PERM-17; 6.7 CA1 e CA2). */
function dirtyEvent() {
  return {
    message: `Falhou com Bearer ${JWT}`,
    user: {
      id: '01a189e0-af57-7000-85fe-2054e618fea6',
      email: 'helena@example.com',
      ip_address: '10.0.0.7',
    },
    request: {
      url: 'http://192.168.0.10:3000/v1/creators/cozinhadabia/follow?cursor=abc',
      headers: { Authorization: `Bearer ${JWT}`, Cookie: 'sessao=1', Accept: 'application/json' },
      data: { password: 'sussurro-dev-2026' },
    },
    exception: {
      values: [{ type: 'Error', value: `token ${PUSH_TOKEN} recusado; jwt=${JWT}` }],
    },
    extra: {
      password: 'sussurro-dev-2026',
      refreshToken: 'refresh-123',
      observedToken: 'LucasTokenFFFFF1',
      targetToken: 'CaioTokenAAAA0001',
      expoToken: PUSH_TOKEN,
      email: 'helena@example.com',
      connections: [{ handle: 'caio.r' }, { handle: 'marinac' }],
      following: [{ handle: 'cozinhadabia' }],
      followerIds: ['01a189e0-af57-7000-8000-000000000001'],
      nearby: [{ handle: 'bia.alves', token: 'BiaTokenBBBB0001' }],
    },
    breadcrumbs: [
      {
        category: 'fetch',
        data: {
          method: 'DELETE',
          url: 'http://192.168.0.10:3000/v1/connections/caio.r',
          status_code: 204,
        },
      },
      { category: 'touch', message: 'Toque em "Perfil de @marinac"' },
      { category: 'console', message: `Authorization: Bearer ${JWT}` },
    ],
  };
}

const FORBIDDEN = [
  JWT,
  'sussurro-dev-2026',
  'refresh-123',
  'LucasTokenFFFFF1',
  'CaioTokenAAAA0001',
  'BiaTokenBBBB0001',
  PUSH_TOKEN,
  'abcdefghijklmnop',
  'helena@example.com',
  '10.0.0.7',
  'caio.r',
  'marinac',
  'cozinhadabia',
  'bia.alves',
  'cursor=abc',
  'sessao=1',
  '01a189e0-af57-7000-8000-000000000001',
];

describe('initSentry (0.9, 6.7)', () => {
  it('CA1 (0.9): sem DSN não inicializa o SDK', () => {
    const { initSentry, init } = load();
    expect(initSentry(undefined)).toBe(false);
    expect(initSentry('   ')).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('6.7 CA4: com DSN inicializa uma vez, sem PII, sem sessões, sem tela nem views', () => {
    const { initSentry, init } = load();
    expect(initSentry(DSN)).toBe(true);
    expect(initSentry(DSN)).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    expect(initOptions(init)).toMatchObject({
      dsn: DSN,
      environment: 'preview',
      sendDefaultPii: false,
      tracesSampleRate: 0,
      enableAutoSessionTracking: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      tracePropagationTargets: ['http://localhost:3000'],
    });
    // Release e dist ficam com o SDK (bundleId@versão+build), iguais aos do upload no EAS.
    expect(initOptions(init)).not.toHaveProperty('release');
    expect(typeof initOptions(init).beforeSend).toBe('function');
    expect(typeof initOptions(init).beforeSendTransaction).toBe('function');
    expect(typeof initOptions(init).beforeBreadcrumb).toBe('function');
  });

  it('6.7 CA3: o erro de teste do catálogo só sai com o Sentry ligado', () => {
    const { initSentry, sendTestError } = load();
    const { captureException } = jest.requireMock<{ captureException: jest.Mock }>(
      '@sentry/react-native',
    );
    expect(sendTestError()).toBe(false);
    expect(captureException).not.toHaveBeenCalled();
    initSentry(DSN);
    expect(sendTestError()).toBe(true);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it('amostragem do tracing por env, de 0 a 1 (inválida = 0)', () => {
    const { tracesSampleRate, initSentry, init } = load();
    expect(tracesSampleRate(undefined)).toBe(0);
    expect(tracesSampleRate('')).toBe(0);
    expect(tracesSampleRate('0.1')).toBe(0.1);
    expect(tracesSampleRate('1')).toBe(1);
    expect(tracesSampleRate('2')).toBe(0);
    expect(tracesSampleRate('-0.5')).toBe(0);
    expect(tracesSampleRate('abc')).toBe(0);
    initSentry(DSN, 'production', 0.05);
    expect(initOptions(init)).toMatchObject({ environment: 'production', tracesSampleRate: 0.05 });
  });
});

describe('PERM-17 no app: o que sai para o Sentry (6.7 CA1 e CA2)', () => {
  it('o beforeSend tira token, Bearer, JWT, push token, senha, e-mail, IP, cookies e listas de relacionamento', () => {
    const { initSentry, init } = load();
    initSentry(DSN);
    const beforeSend = initOptions(init).beforeSend as (event: object, hint: object) => object;
    const sent = beforeSend(dirtyEvent(), {});
    const json = JSON.stringify(sent);
    for (const value of FORBIDDEN) {
      expect(json).not.toContain(value);
    }
    expect(sent).not.toHaveProperty('user');
    expect(sent).toMatchObject({
      request: {
        url: 'http://192.168.0.10:3000/v1/creators/:handle/follow',
        headers: { Accept: 'application/json' },
      },
    });
    // O que ajuda a investigar continua: o tipo do erro, o método e o caminho mascarado.
    expect(json).toContain('/v1/connections/:handle');
    expect(json).toContain('"status_code":204');
    expect(json).toContain('"type":"Error"');
  });

  it('o beforeBreadcrumb descarta toques e mascara URLs e rotas', () => {
    const { scrubBreadcrumb } = load();
    expect(scrubBreadcrumb({ category: 'touch', message: 'Perfil de @marinac' })).toBeNull();
    const xhr = scrubBreadcrumb({
      category: 'xhr',
      data: {
        method: 'PUT',
        url: 'https://s3.example/sussurro-media/incoming/01a189e0-af57-7000-8000-000000000001/0?X-Amz-Signature=abc',
      },
    })!;
    expect(xhr.data).toEqual({
      method: 'PUT',
      url: 'https://s3.example/sussurro-media/incoming/:id/0',
    });
    const navigation = scrubBreadcrumb({
      category: 'navigation',
      data: { from: '/pessoal/inicio/u/marinac', to: '/c/CaioTokenAAAA0001' },
    })!;
    expect(navigation.data).toEqual({ from: '/pessoal/inicio/u/:handle', to: '/c/:token' });
    const logged = scrubBreadcrumb({
      category: 'console',
      message: `GET http://api/v1/users/marinac/posts falhou com ${PUSH_TOKEN}`,
    })!;
    expect(logged.message).toBe('GET http://api/v1/users/:handle/posts falhou com [Filtered]');
  });

  it('o beforeSendTransaction mascara os spans HTTP', () => {
    const { initSentry, init } = load();
    initSentry(DSN, 'preview', 1);
    const beforeSendTransaction = initOptions(init).beforeSendTransaction as (
      event: object,
      hint: object,
    ) => { spans: { description: string }[] };
    const sent = beforeSendTransaction(
      {
        type: 'transaction',
        transaction: 'App Start',
        spans: [
          { op: 'http.client', description: 'PUT http://api/v1/creators/cozinhadabia/follow' },
          { op: 'http.client', description: 'GET http://api/v1/me/blocks?cursor=abc' },
        ],
      },
      {},
    );
    expect(sent.spans.map((span) => span.description)).toEqual([
      'PUT http://api/v1/creators/:handle/follow',
      'GET http://api/v1/me/blocks',
    ]);
  });

  it('maskPath: ids, @ e o token do QR; rotas fixas ficam', () => {
    const { maskPath } = load();
    expect(maskPath('/v1/users/marinac/posts?type=photo')).toBe('/v1/users/:handle/posts');
    expect(maskPath('/v1/connections/requests/incoming')).toBe('/v1/connections/requests/incoming');
    expect(maskPath('/v1/connections/requests/01a189e0-af57-7000-85fe-2054e618fe04/accept')).toBe(
      '/v1/connections/requests/:id/accept',
    );
    expect(maskPath('/v1/me/blocks/caio.r')).toBe('/v1/me/blocks/:handle');
    expect(maskPath('/v1/me/connections')).toBe('/v1/me/connections');
    expect(maskPath('/v1/notifications/unread-count')).toBe('/v1/notifications/unread-count');
  });
});
