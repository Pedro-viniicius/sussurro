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

describe('ApiClient: a época da sessão no 401 (AUTH-15; BAIXO do seguranca)', () => {
  const POST_BODY = { type: 'text', text: 'Post de A' };

  it('AUTH-15: o 401 com a conta trocada no meio do voo (sair de A, entrar em B) não repete a chamada com o token de B, nem renova, nem avisa sessão expirada', async () => {
    const { api, client, store } = setup();
    const sessionA = tokenPair();
    const sessionB = tokenPair();
    await client.setSession(sessionA);
    const expired = jest.fn();
    client.onSessionExpired(expired);
    api.on('POST /v1/posts', async () => {
      // Enquanto a chamada de A voa, A sai e B entra; o servidor responde 401 ao token de A.
      await client.clearSession();
      await client.setSession(sessionB);
      return unauthorized;
    });

    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });

    // Uma ida só, com o token de A: a ação de A nunca roda na conta B.
    const posts = api.callsTo('POST /v1/posts');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.headers.Authorization).toBe(`Bearer ${sessionA.accessToken}`);
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(0);
    expect(expired).not.toHaveBeenCalled();
    // A sessão de B continua.
    await expect(store.getRefreshToken()).resolves.toBe(sessionB.refreshToken);
    api.on('GET /v1/me', { status: 200, body: personalMe() });
    await client.request('/v1/me', { schema: MeSchema });
    expect(api.callsTo('GET /v1/me')[0]?.headers.Authorization).toBe(
      `Bearer ${sessionB.accessToken}`,
    );
  });

  it('AUTH-15 (controle) / AUTH-10: o 401 com o token renovado por outra chamada no meio do voo (a mesma sessão) continua repetindo, sem um 2º refresh', async () => {
    const { api, client } = setup('r0');
    await client.setSession({ ...tokenPair(), accessToken: 'vencido' });
    const fresh = tokenPair();
    api.on('POST /v1/auth/refresh', { status: 200, body: fresh });
    const valid = (authorization: string | undefined) =>
      authorization === `Bearer ${fresh.accessToken}`;
    api.on('GET /v1/me', ({ headers }) =>
      valid(headers.Authorization) ? { status: 200, body: personalMe() } : unauthorized,
    );
    api.on('POST /v1/posts', async ({ headers }) => {
      if (valid(headers.Authorization)) return { status: 204 };
      // Enquanto esta voa com o token vencido, outra chamada recebe 401 e renova o token.
      await client.request('/v1/me', { schema: MeSchema });
      return unauthorized;
    });

    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).resolves.toBeUndefined();
    const posts = api.callsTo('POST /v1/posts');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers.Authorization).toBe(`Bearer ${fresh.accessToken}`);
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(1);
  });

  it('AUTH-15 (controle) / AUTH-10: o refresh normal (a mesma sessão) continua repetindo a chamada com o token novo', async () => {
    const { api, client, store } = setup('r0');
    await client.setSession({ ...tokenPair(), accessToken: 'vencido' });
    const fresh = tokenPair();
    api.on('POST /v1/auth/refresh', { status: 200, body: fresh });
    api.on('POST /v1/posts', ({ headers }) =>
      headers.Authorization === `Bearer ${fresh.accessToken}` ? { status: 204 } : unauthorized,
    );
    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).resolves.toBeUndefined();
    expect(api.callsTo('POST /v1/posts')).toHaveLength(2);
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(1);
    await expect(store.getRefreshToken()).resolves.toBe(fresh.refreshToken);
  });

  it('AUTH-15: a conta trocada durante o refresh → o par de A é descartado (a sessão de B fica), e a chamada de A não repete nem avisa', async () => {
    const { api, client, store } = setup();
    const sessionA = tokenPair();
    const sessionB = tokenPair();
    const renewedA = tokenPair();
    await client.setSession({ ...sessionA, accessToken: 'vencido' });
    const expired = jest.fn();
    client.onSessionExpired(expired);
    api.on('POST /v1/auth/refresh', async () => {
      // A sai e B entra enquanto o refresh de A voa.
      await client.clearSession();
      await client.setSession(sessionB);
      return { status: 200, body: renewedA };
    });
    api.on('POST /v1/posts', unauthorized);

    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(api.callsTo('POST /v1/posts')).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
    await expect(store.getRefreshToken()).resolves.toBe(sessionB.refreshToken);
    api.on('GET /v1/me', { status: 200, body: personalMe() });
    await client.request('/v1/me', { schema: MeSchema });
    expect(api.callsTo('GET /v1/me')[0]?.headers.Authorization).toBe(
      `Bearer ${sessionB.accessToken}`,
    );
  });

  it('AUTH-15: o refresh de A recusado (401) depois que B entrou não limpa a sessão de B nem avisa sessão expirada', async () => {
    const { api, client, store } = setup();
    const sessionB = tokenPair();
    await client.setSession({ ...tokenPair(), accessToken: 'vencido' });
    const expired = jest.fn();
    client.onSessionExpired(expired);
    api.on('POST /v1/auth/refresh', async () => {
      await client.clearSession();
      await client.setSession(sessionB);
      return unauthorized;
    });
    api.on('POST /v1/posts', unauthorized);

    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();
    await expect(store.getRefreshToken()).resolves.toBe(sessionB.refreshToken);
  });

  type StoreMethod = 'getRefreshToken' | 'setRefreshToken' | 'clearRefreshToken';

  /**
   * Roda `hook` uma vez, logo depois da próxima chamada de `method` no armazenamento (a troca de
   * sessão no meio da leitura, da gravação ou da limpeza do refresh guardado).
   */
  function afterNext(
    store: ReturnType<typeof setup>['store'],
    method: StoreMethod,
    hook: () => Promise<void>,
    when: (token?: string) => boolean = () => true,
  ) {
    let armed = true;
    const fire = async (token?: string) => {
      if (!armed || !when(token)) return;
      armed = false;
      await hook();
    };
    if (method === 'getRefreshToken') {
      const original = store.getRefreshToken;
      store.getRefreshToken = async () => {
        const value = await original();
        await fire();
        return value;
      };
    } else if (method === 'setRefreshToken') {
      const original = store.setRefreshToken;
      store.setRefreshToken = async (token) => {
        await original(token);
        await fire(token);
      };
    } else {
      const original = store.clearRefreshToken;
      store.clearRefreshToken = async () => {
        await original();
        await fire();
      };
    }
  }

  it('AUTH-15: A sai no meio do voo, sem outra conta entrar → o 401 não renova nem avisa sessão expirada (quem saiu não recebe "Sua sessão expirou")', async () => {
    const { api, client, store } = setup();
    const sessionA = tokenPair();
    await client.setSession(sessionA);
    const expired = jest.fn();
    client.onSessionExpired(expired);
    api.on('POST /v1/posts', async () => {
      await client.clearSession();
      return unauthorized;
    });

    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(api.callsTo('POST /v1/posts')).toHaveLength(1);
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(0);
    expect(expired).not.toHaveBeenCalled();
    await expect(store.getRefreshToken()).resolves.toBeNull();
  });

  it('AUTH-15: B entra enquanto o par renovado de A é gravado (o refresh já voltou) → a chamada de A não repete com o token de B, e a sessão de B fica', async () => {
    const { api, client, store } = setup();
    const sessionA = tokenPair();
    const renewedA = tokenPair();
    const sessionB = tokenPair();
    await client.setSession({ ...sessionA, accessToken: 'vencido' });
    const expired = jest.fn();
    client.onSessionExpired(expired);
    afterNext(
      store,
      'setRefreshToken',
      async () => {
        await client.clearSession();
        await client.setSession(sessionB);
      },
      (token) => token === renewedA.refreshToken,
    );
    api.on('POST /v1/auth/refresh', { status: 200, body: renewedA });
    api.on('POST /v1/posts', ({ headers }) =>
      headers.Authorization === `Bearer ${sessionB.accessToken}` ? { status: 204 } : unauthorized,
    );

    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    // Uma ida só, com o token de A: o post de A nunca sai com o token de B.
    expect(api.callsTo('POST /v1/posts').map((call) => call.headers.Authorization)).toEqual([
      'Bearer vencido',
    ]);
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
    await expect(store.getRefreshToken()).resolves.toBe(sessionB.refreshToken);
  });

  it('AUTH-15: B entra durante a limpeza do refresh recusado de A → nada de "sessão expirada" para B, e a sessão de B fica', async () => {
    const { api, client, store } = setup();
    const sessionB = tokenPair();
    await client.setSession({ ...tokenPair(), accessToken: 'vencido' });
    const expired = jest.fn();
    client.onSessionExpired(expired);
    afterNext(store, 'clearRefreshToken', async () => {
      await client.setSession(sessionB);
    });
    api.on('POST /v1/auth/refresh', unauthorized);
    api.on('POST /v1/posts', unauthorized);
    api.on('GET /v1/me', ({ headers }) =>
      headers.Authorization === `Bearer ${sessionB.accessToken}`
        ? { status: 200, body: personalMe() }
        : unauthorized,
    );

    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).rejects.toMatchObject({ status: 401 });
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
    await expect(store.getRefreshToken()).resolves.toBe(sessionB.refreshToken);
    await expect(client.request('/v1/me', { schema: MeSchema })).resolves.toBeDefined();
  });

  it('AUTH-15 (controle): o refresh recusado da sessão de agora, sem ninguém entrar na limpeza, continua avisando (AUTH-10)', async () => {
    const { api, client, store } = setup();
    await client.setSession({ ...tokenPair(), accessToken: 'vencido' });
    const expired = jest.fn();
    client.onSessionExpired(expired);
    api.on('POST /v1/auth/refresh', unauthorized);
    api.on('POST /v1/posts', unauthorized);
    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
    await expect(store.getRefreshToken()).resolves.toBeNull();
  });

  it('AUTH-15: a troca de conta durante a leitura do refresh guardado → o refresh de A nem sai, e a sessão de B fica', async () => {
    const { api, client, store } = setup();
    const sessionB = tokenPair();
    await client.setSession({ ...tokenPair(), accessToken: 'vencido' });
    const expired = jest.fn();
    client.onSessionExpired(expired);
    afterNext(store, 'getRefreshToken', async () => {
      await client.clearSession();
      await client.setSession(sessionB);
    });
    api.on('POST /v1/auth/refresh', { status: 200, body: tokenPair() });
    api.on('POST /v1/posts', unauthorized);

    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).rejects.toMatchObject({ status: 401 });
    expect(api.callsTo('POST /v1/auth/refresh')).toHaveLength(0);
    expect(api.callsTo('POST /v1/posts')).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
    await expect(store.getRefreshToken()).resolves.toBe(sessionB.refreshToken);
  });

  it('AUTH-15: a troca de conta enquanto o corpo do refresh de A é lido → o par de A é descartado, a chamada de A não repete, e a sessão de B fica', async () => {
    const api = createFakeApi();
    const store = createMemorySessionStore();
    const sessionB = tokenPair();
    const renewedA = tokenPair();
    let client: ApiClient | null = null;
    // O `fetch` entrega a resposta do refresh; a troca acontece durante o `text()` dela.
    const fetch: FetchLike = async (url, init) => {
      const response = await api.fetch(url, init);
      if (!url.endsWith('/v1/auth/refresh')) return response;
      return {
        ...response,
        text: async () => {
          await client?.clearSession();
          await client?.setSession(sessionB);
          return response.text();
        },
      };
    };
    client = new ApiClient({ baseUrl: BASE_URL, fetch, tokens: store });
    await client.setSession({ ...tokenPair(), accessToken: 'vencido' });
    const expired = jest.fn();
    client.onSessionExpired(expired);
    api.on('POST /v1/auth/refresh', { status: 200, body: renewedA });
    api.on('POST /v1/posts', ({ headers }) =>
      headers.Authorization === `Bearer ${sessionB.accessToken}` ? { status: 204 } : unauthorized,
    );

    await expect(
      client.request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema }),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(api.callsTo('POST /v1/posts').map((call) => call.headers.Authorization)).toEqual([
      'Bearer vencido',
    ]);
    expect(expired).not.toHaveBeenCalled();
    await expect(store.getRefreshToken()).resolves.toBe(sessionB.refreshToken);
  });

  it('AUTH-15: o refresh de A ainda em voo não serve à sessão de B → o 401 de B faz o próprio refresh, com o refresh de B, e repete; o par de A, que volta depois, é descartado', async () => {
    const { api, client, store } = setup();
    const sessionA = tokenPair();
    const renewedA = tokenPair();
    const sessionB = tokenPair();
    const renewedB = tokenPair();
    await client.setSession({ ...sessionA, accessToken: 'vencido-a' });
    const expired = jest.fn();
    client.onSessionExpired(expired);
    let enteredA: () => void = () => undefined;
    const refreshAEntered = new Promise<void>((resolve) => {
      enteredA = resolve;
    });
    let releaseA: () => void = () => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    api.on('POST /v1/auth/refresh', async ({ body }) => {
      const { refreshToken } = body as { refreshToken: string };
      if (refreshToken === sessionA.refreshToken) {
        enteredA();
        await gateA;
        return { status: 200, body: renewedA };
      }
      if (refreshToken === sessionB.refreshToken) return { status: 200, body: renewedB };
      return unauthorized;
    });
    api.on('POST /v1/posts', unauthorized);
    api.on('GET /v1/me', ({ headers }) =>
      headers.Authorization === `Bearer ${renewedB.accessToken}`
        ? { status: 200, body: personalMe() }
        : unauthorized,
    );

    const postOfA = client
      .request('/v1/posts', { method: 'POST', body: POST_BODY, schema: NoContentSchema })
      .then(
        () => 'ok',
        (error: unknown) => error,
      );
    try {
      await refreshAEntered;
      await client.clearSession();
      await client.setSession({ ...sessionB, accessToken: 'vencido-b' });
      const meOfB = client.request('/v1/me', { schema: MeSchema }).then(
        () => 'ok',
        (error: unknown) => error,
      );
      // B não espera o refresh de A (que segue parado): o dele sai e volta antes.
      const resultOfB = await Promise.race([
        meOfB,
        new Promise((resolve) => {
          setTimeout(() => {
            resolve('pendente');
          }, 200);
        }),
      ]);
      expect(resultOfB).toBe('ok');
    } finally {
      releaseA();
    }
    await expect(postOfA).resolves.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(
      api.callsTo('POST /v1/auth/refresh').map((call) => call.body as { refreshToken: string }),
    ).toEqual([{ refreshToken: sessionA.refreshToken }, { refreshToken: sessionB.refreshToken }]);
    expect(api.callsTo('POST /v1/posts')).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
    // O par de A chegou depois e foi descartado: a sessão é a renovada de B.
    await expect(store.getRefreshToken()).resolves.toBe(renewedB.refreshToken);
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
