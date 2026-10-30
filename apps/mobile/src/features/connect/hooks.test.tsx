import { act, renderHook } from '@testing-library/react-native';

import { useProximityToken } from './hooks';
import { useNearby } from './useNearby';
import { createFakeRadio } from '../../../modules/sussurro-proximity/src/fake-radio';
import { ApiClient } from '../../lib/api/client';
import { createMemorySessionStore } from '../../lib/session/secure-session-store';
import { configureConnect, MY_TOKENS, nearbyPerson } from '../../test-utils/connect-fixtures';
import { BASE_URL, createFakeApi, type FakeApi } from '../../test-utils/fake-api';

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

describe('token de proximidade (4.2)', () => {
  it('4.2 CA3: pede um token ao abrir e renova a cada 20 s (renewInS), sem esperar vencer', async () => {
    const api = createFakeApi();
    configureConnect(api);
    const onError = jest.fn();
    const http = client(api);
    const { result } = await renderHook(() => useProximityToken(http, true, onError));
    await advance(0);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(1);
    expect(result.current.token).toBe(MY_TOKENS[0]);

    await advance(19_999);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(1);
    // O token anterior continua até o novo chegar (o QR e o anúncio nunca ficam vazios).
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
});

describe('"Por perto agora": resolve em lote (4.4, A-17)', () => {
  it('A-17: o resolve junta os tokens novos e é chamado no máximo a cada 3 s; o RSSI não vai', async () => {
    const api = createFakeApi();
    api.on('POST /v1/proximity/resolve', ({ body }) => ({
      status: 200,
      body: {
        items: (body as { tokens: string[] }).tokens.map((token, index) =>
          nearbyPerson({
            token,
            handle: `pessoa${String(index)}${token.slice(0, 3)}`,
            name: token,
          }),
        ),
      },
    }));
    const radio = createFakeRadio();
    const onError = jest.fn();
    const http = client(api);
    const { result } = await renderHook(() =>
      useNearby({ api: http, radio, scanning: true, hasOwnToken: true, onError }),
    );
    await advance(0);
    expect(radio.scanning).toBe(true);
    const resolves = () => api.callsTo('POST /v1/proximity/resolve');

    await act(async () => {
      radio.emitSighting('AaaTokenAAAAAAA1', -55);
      await Promise.resolve();
    });
    await advance(0);
    expect(resolves()).toHaveLength(1);
    expect(resolves()[0]?.body).toEqual({ tokens: ['AaaTokenAAAAAAA1'] });

    // Mais dois aparelhos aparecem logo depois: esperam o intervalo de 3 s.
    await advance(500);
    await act(async () => {
      radio.emitSighting('BbbTokenBBBBBBB1', -70);
      radio.emitSighting('CccTokenCCCCCCC1', -80);
      // Um token já resolvido visto de novo não gera chamada.
      radio.emitSighting('AaaTokenAAAAAAA1', -54);
      await Promise.resolve();
    });
    await advance(2_000);
    expect(resolves()).toHaveLength(1);
    await advance(500);
    expect(resolves()).toHaveLength(2);
    expect((resolves()[1]?.body as { tokens: string[] }).tokens.sort()).toEqual([
      'BbbTokenBBBBBBB1',
      'CccTokenCCCCCCC1',
    ]);
    // Só os tokens: nada de RSSI no corpo (o sinal fica no aparelho).
    expect(JSON.stringify(resolves().map((call) => call.body))).not.toMatch(/rssi|-5|-7|-8/);

    await advance(1_000);
    expect(result.current.snapshot.rows.map((row) => row.band)).toEqual([
      'bem perto',
      'por perto',
      'por perto',
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('sem varrer: não escuta o rádio nem chama o resolve; ao parar, a varredura para', async () => {
    const api = createFakeApi();
    const radio = createFakeRadio();
    const http = client(api);
    const onError = jest.fn();
    const { rerender } = await renderHook(
      ({ scanning }: { scanning: boolean }) =>
        useNearby({ api: http, radio, scanning, hasOwnToken: true, onError }),
      { initialProps: { scanning: true } },
    );
    await advance(0);
    expect(radio.scanning).toBe(true);
    await rerender({ scanning: false });
    await advance(0);
    expect(radio.scanning).toBe(false);
    radio.emitSighting('AaaTokenAAAAAAA1', -55);
    await advance(5_000);
    expect(api.callsTo('POST /v1/proximity/resolve')).toHaveLength(0);
  });
});
