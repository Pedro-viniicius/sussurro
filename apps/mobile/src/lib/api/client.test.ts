import { MeSchema, NoContentSchema } from '@sussurro/shared';

import { ApiClient, type FetchLike } from './client';
import { ApiError, NetworkError } from './errors';
import { BASE_URL, createFakeApi, personalMe, tokenPair } from '../../test-utils/fake-api';
import { createMemorySessionStore } from '../session/secure-session-store';

function setup(refreshToken?: string) {
  const api = createFakeApi();
  const store = createMemorySessionStore(refreshToken === undefined ? {} : { refreshToken });
  const client = new ApiClient({ baseUrl: BASE_URL, fetch: api.fetch, tokens: store });
  return { api, store, client };
}

const unauthorized = { status: 401, body: { code: 'UNAUTHORIZED', message: 'expirado' } };

describe('ApiClient (ADR 0007)', () => {
  it('manda o access token e valida a resposta pelo schema de packages/shared', async () => {
    const { api, client } = setup();
    await client.setSession(tokenPair());
    api.on('GET /v1/me', { status: 200, body: { ...personalMe(), passwordHash: 'x' } });
    const me = await client.request('/v1/me', { schema: MeSchema });
    expect(me).not.toHaveProperty('passwordHash');
    expect(api.calls[0]?.headers.Authorization).toMatch(/^Bearer access-/);
  });

  it('[AUTH-10] 5 chamadas com 401 ao mesmo tempo → 1 refresh e as 5 repetidas', async () => {
    const { api, client } = setup('r0');
    await client.setSession({ ...tokenPair(), accessToken: 'vencido' });
    const fresh = tokenPair();
    api.on('POST /v1/auth/refresh', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { status: 200, body: fresh };
    });
    api.on('GET /v1/me', ({ headers }) =>
      headers.Authorization === `Bearer ${fresh.accessToken}`
        ? { status: 200, body: personalMe() }
        : unauthorized,
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.request('/v1/me', { schema: MeSchema })),
    );

    expect(results).toHaveLength(5);
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(1);
    expect(api.callsTo('GET /v1/me')).toHaveLength(10);
  });

  it('[AUTH-10] refresh recusado → limpa a sessão e avisa (volta para Entrar)', async () => {
    const { api, client, store } = setup('r0');
    const expired = jest.fn();
    client.onSessionExpired(expired);
    api.on('GET /v1/me', unauthorized);
    api.on('POST /v1/auth/refresh', unauthorized);

    await expect(client.request('/v1/me', { schema: MeSchema })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(expired).toHaveBeenCalledTimes(1);
    await expect(store.getRefreshToken()).resolves.toBeNull();
  });

  it('401 de credencial (senha errada) não dispara refresh', async () => {
    const { api, client } = setup('r0');
    api.on('DELETE /v1/me', {
      status: 401,
      body: { code: 'INVALID_CREDENTIALS', message: 'Senha incorreta' },
    });
    await expect(
      client.request('/v1/me', {
        method: 'DELETE',
        body: { password: 'x' },
        schema: NoContentSchema,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(0);
  });

  it('rota pública (auth: false) não manda token nem tenta refresh', async () => {
    const { api, client } = setup('r0');
    await client.setSession(tokenPair());
    api.on('POST /v1/auth/login', unauthorized);
    await expect(
      client.request('/v1/auth/login', {
        method: 'POST',
        body: {},
        schema: NoContentSchema,
        auth: false,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(api.calls[0]?.headers.Authorization).toBeUndefined();
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(0);
  });

  it('[AUTH-13] só o refresh vai para o armazenamento; o access token fica em memória', async () => {
    const { client, store } = setup();
    const pair = tokenPair();
    await client.setSession(pair);
    expect([...store.values.values()]).toEqual([pair.refreshToken]);
    expect([...store.values.values()]).not.toContain(pair.accessToken);
  });

  it('restoreSession: sem refresh guardado não chama a API; com refresh, troca por um par novo', async () => {
    const empty = setup();
    await expect(empty.client.restoreSession()).resolves.toBe(false);
    expect(empty.api.calls).toHaveLength(0);

    const stored = setup('r0');
    const next = tokenPair();
    stored.api.on('POST /v1/auth/refresh', { status: 200, body: next });
    await expect(stored.client.restoreSession()).resolves.toBe(true);
    expect(stored.api.calls[0]?.body).toEqual({ refreshToken: 'r0' });
    await expect(stored.store.getRefreshToken()).resolves.toBe(next.refreshToken);
  });

  it('sem rede → NetworkError; 204 sem corpo → undefined; erro sem corpo → código pelo status', async () => {
    const offline = new ApiClient({
      baseUrl: BASE_URL,
      fetch: () => Promise.reject(new TypeError('Network request failed')),
      tokens: createMemorySessionStore(),
    });
    await expect(offline.request('/v1/me', { schema: MeSchema })).rejects.toBeInstanceOf(
      NetworkError,
    );

    const { api, client } = setup();
    api.on('POST /v1/auth/logout', { status: 204 });
    await expect(
      client.request('/v1/auth/logout', { method: 'POST', schema: NoContentSchema }),
    ).resolves.toBeUndefined();

    api.on('GET /v1/users/x', { status: 503 });
    await expect(client.request('/v1/users/x', { schema: MeSchema })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});

describe('ApiClient: prazo da chamada (ADR 0012, A3-3 item 1)', () => {
  /** Um `fetch` que só termina quando abortado (`honorSignal`) ou nunca. */
  function hangingFetch(honorSignal: boolean) {
    const signals: (AbortSignal | undefined)[] = [];
    const fetch: FetchLike = (_url, init) => {
      signals.push(init.signal);
      return new Promise((_resolve, reject) => {
        if (!honorSignal) return;
        init.signal?.addEventListener('abort', () => {
          reject(new Error('AbortError'));
        });
      });
    };
    return { fetch, signals };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['o fetch respeita o signal', true],
    ['o fetch ignora o signal', false],
  ] as const)(
    'PROX-68: sem resposta no prazo → aborta a conexão e falha com NetworkError (%s)',
    async (_case, honorSignal) => {
      const { fetch, signals } = hangingFetch(honorSignal);
      const client = new ApiClient({
        baseUrl: BASE_URL,
        fetch,
        tokens: createMemorySessionStore(),
      });
      const call = client.request('/v1/proximity/resolve', {
        method: 'POST',
        body: { tokens: ['CaioTokenBBBBBB1'] },
        schema: NoContentSchema,
        timeoutMs: 4000,
      });
      const settled = jest.fn();
      call.then(settled, settled);
      await jest.advanceTimersByTimeAsync(3999);
      expect(settled).not.toHaveBeenCalled();
      expect(signals[0]?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(call).rejects.toBeInstanceOf(NetworkError);
      // O `signal` do fetch foi abortado: a conexão não fica aberta por trás.
      expect(signals[0]?.aborted).toBe(true);
    },
  );

  it('PROX-68: resposta antes do prazo → resolve e não deixa relógio pendente; sem timeoutMs, nenhum signal vai ao fetch', async () => {
    const { api, client } = setup();
    api.on('POST /v1/auth/logout', { status: 204 });
    await expect(
      client.request('/v1/auth/logout', {
        method: 'POST',
        schema: NoContentSchema,
        timeoutMs: 4000,
      }),
    ).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);

    const { fetch, signals } = hangingFetch(true);
    const plain = new ApiClient({ baseUrl: BASE_URL, fetch, tokens: createMemorySessionStore() });
    void plain.request('/v1/me', { schema: MeSchema }).catch(() => undefined);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(signals).toEqual([undefined]);
  });

  it('PROX-68: o prazo acaba durante o refresh do 401 → NetworkError, sem repetir a chamada; o refresh termina para as outras', async () => {
    const { api, client, store } = setup('r0');
    await client.setSession({ ...tokenPair(), accessToken: 'vencido' });
    const fresh = tokenPair();
    api.on('POST /v1/auth/refresh', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { status: 200, body: fresh };
    });
    api.on('POST /v1/proximity/resolve', unauthorized);
    const call = client.request('/v1/proximity/resolve', {
      method: 'POST',
      body: { tokens: ['CaioTokenBBBBBB1'] },
      schema: NoContentSchema,
      timeoutMs: 4000,
    });
    const rejected = expect(call).rejects.toBeInstanceOf(NetworkError);
    await jest.advanceTimersByTimeAsync(4000);
    await rejected;
    await jest.advanceTimersByTimeAsync(2000);
    expect(api.callsTo('POST /v1/proximity/resolve')).toHaveLength(1);
    await expect(store.getRefreshToken()).resolves.toBe(fresh.refreshToken);
  });
});
