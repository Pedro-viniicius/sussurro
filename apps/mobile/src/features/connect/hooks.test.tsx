import { PROXIMITY_RENEW_INTERVAL_S, PROXIMITY_TOKEN_TTL_S } from '@sussurro/shared';
import { act, renderHook } from '@testing-library/react-native';

import { haltReasonFor } from './errors';
import { useProximityToken } from './hooks';
import { connectTiming } from './timing';
import { ApiClient } from '../../lib/api/client';
import { createMemorySessionStore } from '../../lib/session/secure-session-store';
import {
  apiError,
  configureConnect,
  MY_TOKENS,
  proximityToken,
} from '../../test-utils/connect-fixtures';
import { BASE_URL, createFakeApi, type FakeApi, type FakeReply } from '../../test-utils/fake-api';

/** A emissão que não chega ao servidor: o `fetch` falha e vira `NetworkError`. */
function offline(): never {
  throw new Error('sem rede');
}

/**
 * O servidor com o limite das emissões (`prox-tokens:user`: 6 por minuto, PROX-20): toda chamada
 * chega a ele e conta, também a que falha depois (a resposta perdida). Acima de 6 em 60 s, 429. Cada
 * chamada segue o `script` (`ok` → 201; `fail` → `fail()`), e depois do fim dele, `fail`.
 */
function limitedServer(api: FakeApi, script: readonly ('ok' | 'fail')[], fail: () => FakeReply) {
  const hits: number[] = [];
  const server = { calls: 0, rateLimited: 0 };
  api.on('POST /v1/proximity/tokens', () => {
    const now = Date.now();
    hits.push(now);
    const step = script[server.calls] ?? 'fail';
    server.calls += 1;
    if (hits.filter((at) => now - at < 60_000).length > 6) {
      server.rateLimited += 1;
      return apiError(429, 'RATE_LIMITED');
    }
    return step === 'ok' ? { status: 201, body: proximityToken(server.calls) } : fail();
  });
  return server;
}

function client(api: FakeApi) {
  return new ApiClient({
    baseUrl: BASE_URL,
    fetch: api.fetch,
    tokens: createMemorySessionStore({}),
  });
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-30T12:00:00.000Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('token de proximidade (4.2, ADR 0013 §1)', () => {
  it('4.2 CA3: pede o token ao abrir e renova a cada 20 s (renewInS), sem esperar vencer', async () => {
    const api = createFakeApi();
    configureConnect(api);
    const onError = jest.fn();
    const http = client(api);
    const { result } = await renderHook(() => useProximityToken(http, true, onError));
    await advance(0);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(1);
    // Um token só: o mesmo no QR e no NFC.
    expect(result.current.token).toBe(MY_TOKENS[0]);

    await advance(19_999);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(1);
    // Os anteriores continuam até os novos chegarem (o QR e o anúncio nunca ficam vazios).
    expect(result.current.token).toBe(MY_TOKENS[0]);

    await advance(1);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(2);
    expect(result.current.token).toBe(MY_TOKENS[1]);

    await advance(20_000);
    expect(result.current.token).toBe(MY_TOKENS[2]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('inativo (tela fechada ou em background): não pede token', async () => {
    const api = createFakeApi();
    configureConnect(api);
    const http = client(api);
    await renderHook(() => useProximityToken(http, false, jest.fn()));
    await advance(60_000);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(0);
  });

  it('4.2 CA5: erro (503) vai para a tela decidir e a renovação para', async () => {
    const api = createFakeApi();
    api.on('POST /v1/proximity/tokens', {
      status: 503,
      body: { code: 'PROXIMITY_UNAVAILABLE', message: 'x' },
    });
    const onError = jest.fn();
    const http = client(api);
    await renderHook(() => useProximityToken(http, true, onError));
    await advance(0);
    expect(onError).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(1);
  });

  it('PROX-68: as 3 tentativas de 3 s cabem nos 10 s entre a renovação (20 s) e o fim da validade (30 s)', () => {
    expect(connectTiming.tokenRetryMs).toBe(3000);
    expect(connectTiming.tokenRetries).toBe(3);
    expect(
      PROXIMITY_RENEW_INTERVAL_S * 1000 + connectTiming.tokenRetries * connectTiming.tokenRetryMs,
    ).toBeLessThan(PROXIMITY_TOKEN_TTL_S * 1000);
  });

  it.each([
    ['sem rede', offline],
    ['503', () => apiError(503, 'PROXIMITY_UNAVAILABLE')],
  ] as const)(
    'PROX-68: a renovação com falha repetível (%s) tenta de novo a cada 3 s, até 3 vezes, e só então para a tela',
    async (_case, fail) => {
      const api = createFakeApi();
      let calls = 0;
      api.on('POST /v1/proximity/tokens', () => {
        calls += 1;
        return calls === 1 ? { status: 201, body: proximityToken(0) } : fail();
      });
      const onError = jest.fn();
      const http = client(api);
      const { result } = await renderHook(() => useProximityToken(http, true, onError));
      await advance(0);
      await advance(20_000);
      // A renovação dos 20 s falhou: o token de antes continua (valem até os 30 s).
      expect(calls).toBe(2);
      expect(result.current.token).toBe(MY_TOKENS[0]);
      await advance(3000);
      expect(calls).toBe(3);
      await advance(3000);
      expect(calls).toBe(4);
      await advance(2999);
      expect(onError).not.toHaveBeenCalled();
      await advance(1);
      expect(calls).toBe(5);
      expect(onError).toHaveBeenCalledTimes(1);
      await advance(60_000);
      expect(calls).toBe(5);
    },
  );

  it('PROX-68: a renovação que volta na 2ª tentativa segue o ciclo de 20 s; a falha seguinte, com a janela de 60 s livre, ganha as 3 tentativas de novo', async () => {
    const api = createFakeApi();
    // 0 s certo; 20 e 23 s sem rede; 26, 46 e 66 s certos; 86, 89, 92 e 95 s sem rede. Aos 95 s, a
    // janela tem 46, 66, 86, 89 e 92: a 3ª tentativa é a 6ª emissão em 60 s e ainda sai.
    const replies = [true, false, false, true, true, true, false, false, false, false];
    let calls = 0;
    api.on('POST /v1/proximity/tokens', () => {
      const ok = replies[calls] ?? false;
      calls += 1;
      return ok ? { status: 201, body: proximityToken(calls) } : offline();
    });
    const onError = jest.fn();
    const http = client(api);
    const { result } = await renderHook(() => useProximityToken(http, true, onError));
    await advance(0);
    await advance(26_000);
    expect(calls).toBe(4);
    expect(result.current.token).toBe(MY_TOKENS[2]);
    await advance(40_000);
    expect(calls).toBe(6);
    await advance(20_000 + 9000 - 1);
    expect(calls).toBe(9);
    expect(onError).not.toHaveBeenCalled();
    await advance(1);
    expect(calls).toBe(10);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['resposta perdida (sem rede)', offline, 'offline'],
    ['503', () => apiError(503, 'PROXIMITY_UNAVAILABLE'), 'unavailable'],
  ] as const)(
    'PROX-68 (teto de 6 emissões em 60 s, %s): [certo, falha ×3, certo, falha ×4] → nenhum 7º pedido em 60 s; a tela para aos 52 s com o último erro repetível, nunca com o 429 ("Muitas tentativas")',
    async (_case, fail, reason) => {
      const api = createFakeApi();
      // 0 s certo; 20, 23 e 26 s com falha; 29 s certo; 49 s com falha. A tentativa dos 52 s seria a
      // 7ª emissão em 60 s (0, 20, 23, 26, 29 e 49): o servidor responderia 429.
      const server = limitedServer(api, ['ok', 'fail', 'fail', 'fail', 'ok'], fail);
      const onError = jest.fn();
      const http = client(api);
      await renderHook(() => useProximityToken(http, true, onError));
      await advance(0);
      await advance(52_000 - 1);
      expect(server.calls).toBe(6);
      expect(onError).not.toHaveBeenCalled();
      await advance(1);
      expect(server.calls).toBe(6);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(haltReasonFor(onError.mock.calls[0]?.[0])).toBe(reason);
      await advance(120_000);
      expect(server.calls).toBe(6);
      expect(server.rateLimited).toBe(0);
      expect(onError).toHaveBeenCalledTimes(1);
    },
  );

  it('PROX-68 (teto): o refresh (409 de tela fechada) também conta — com 2 refresh no início, a 2ª tentativa da renovação já não sai, e o servidor nunca responde 429', async () => {
    const api = createFakeApi();
    // 0 s certo; refresh aos 5 e aos 10 s (certos); 20, 23 e 26 s sem rede. Aos 29 s, a tentativa
    // seria a 7ª emissão em 60 s (0, 5, 10, 20, 23 e 26).
    const server = limitedServer(api, ['ok', 'ok', 'ok'], offline);
    const onError = jest.fn();
    const http = client(api);
    const { result } = await renderHook(() => useProximityToken(http, true, onError));
    await advance(0);
    await advance(5000);
    await act(async () => {
      await result.current.refresh();
    });
    await advance(5000);
    await act(async () => {
      await result.current.refresh();
    });
    await advance(10_000 + 6000);
    expect(server.calls).toBe(6);
    expect(onError).not.toHaveBeenCalled();
    await advance(3000);
    expect(server.calls).toBe(6);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(haltReasonFor(onError.mock.calls[0]?.[0])).toBe('offline');
    expect(server.rateLimited).toBe(0);
  });

  it('PROX-68 (teto): a janela de 60 s vale entre visitas — o segundo plano não zera a contagem; o 1º pedido da visita nova sai e conta, e a tentativa que seria a 7ª em 60 s não sai', async () => {
    const api = createFakeApi();
    // 0 s certo; 20 e 23 s sem rede; segundo plano aos 24 s e volta aos 25 s (1º pedido da visita,
    // certo); 45 e 48 s sem rede. Aos 51 s, a tentativa seria a 7ª emissão em 60 s (0, 20, 23, 25,
    // 45 e 48), contando as da visita anterior.
    const server = limitedServer(api, ['ok', 'fail', 'fail', 'ok'], offline);
    const onError = jest.fn();
    const http = client(api);
    const { rerender } = await renderHook(
      ({ active }: { active: boolean }) => useProximityToken(http, active, onError),
      { initialProps: { active: true } },
    );
    await advance(0);
    await advance(24_000);
    expect(server.calls).toBe(3);
    await rerender({ active: false });
    await advance(1000);
    await rerender({ active: true });
    await advance(0);
    expect(server.calls).toBe(4);
    await advance(26_000 - 1);
    expect(server.calls).toBe(6);
    expect(onError).not.toHaveBeenCalled();
    await advance(1);
    expect(server.calls).toBe(6);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(haltReasonFor(onError.mock.calls[0]?.[0])).toBe('offline');
    expect(server.rateLimited).toBe(0);
  });

  it('PROX-68 (teto): a renovação normal, a cada 20 s e sem falha, nunca chega ao teto (5 min, 16 emissões, sem erro)', async () => {
    const api = createFakeApi();
    const server = limitedServer(
      api,
      Array.from({ length: 20 }, () => 'ok' as const),
      offline,
    );
    const onError = jest.fn();
    const http = client(api);
    await renderHook(() => useProximityToken(http, true, onError));
    await advance(0);
    await advance(300_000);
    expect(server.calls).toBe(16);
    expect(server.rateLimited).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['429 na renovação', 2, apiError(429, 'RATE_LIMITED')],
    ['sem rede no 1º pedido da visita (sem token ainda)', 1, 'offline'],
    ['503 no 1º pedido da visita', 1, apiError(503, 'PROXIMITY_UNAVAILABLE')],
  ] as const)('PROX-68: %s para na hora, sem tentar de novo', async (_case, failingCall, reply) => {
    const api = createFakeApi();
    let calls = 0;
    api.on('POST /v1/proximity/tokens', () => {
      calls += 1;
      if (calls < failingCall) return { status: 201, body: proximityToken(0) };
      return reply === 'offline' ? offline() : reply;
    });
    const onError = jest.fn();
    const http = client(api);
    await renderHook(() => useProximityToken(http, true, onError));
    await advance(0);
    await advance(20_000 * (failingCall - 1));
    expect(onError).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(calls).toBe(failingCall);
  });

  it('refresh: pede o token fora do ciclo (depois de um 409 de tela fechada)', async () => {
    const api = createFakeApi();
    configureConnect(api);
    const http = client(api);
    const { result } = await renderHook(() => useProximityToken(http, true, jest.fn()));
    await advance(0);
    await act(async () => {
      await result.current.refresh();
    });
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(2);
    expect(result.current.token).toBe(MY_TOKENS[1]);
  });
});
