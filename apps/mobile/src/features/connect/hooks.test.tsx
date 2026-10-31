import { act, renderHook } from '@testing-library/react-native';

import { useProximityToken } from './hooks';
import { ApiClient } from '../../lib/api/client';
import { createMemorySessionStore } from '../../lib/session/secure-session-store';
import { configureConnect, MY_BLE_TOKENS, MY_QR_TOKENS } from '../../test-utils/connect-fixtures';
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

describe('tokens de proximidade (4.2, ADR 0012 §1)', () => {
  it('4.2 CA3: pede os dois tokens ao abrir e renova a cada 20 s (renewInS), sem esperar vencer', async () => {
    const api = createFakeApi();
    configureConnect(api);
    const onError = jest.fn();
    const http = client(api);
    const { result } = await renderHook(() => useProximityToken(http, true, onError));
    await advance(0);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(1);
    // Um por canal: o bleToken vai no anúncio; o qrToken, no QR.
    expect(result.current.tokens).toEqual({
      bleToken: MY_BLE_TOKENS[0],
      qrToken: MY_QR_TOKENS[0],
    });

    await advance(19_999);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(1);
    // Os anteriores continuam até os novos chegarem (o QR e o anúncio nunca ficam vazios).
    expect(result.current.tokens?.bleToken).toBe(MY_BLE_TOKENS[0]);

    await advance(1);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(2);
    expect(result.current.tokens).toEqual({
      bleToken: MY_BLE_TOKENS[1],
      qrToken: MY_QR_TOKENS[1],
    });

    await advance(20_000);
    expect(result.current.tokens?.qrToken).toBe(MY_QR_TOKENS[2]);
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

  it('refresh: pede os tokens fora do ciclo (depois de um 409 de tela fechada)', async () => {
    const api = createFakeApi();
    configureConnect(api);
    const http = client(api);
    const { result } = await renderHook(() => useProximityToken(http, true, jest.fn()));
    await advance(0);
    await act(async () => {
      await result.current.refresh();
    });
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(2);
    expect(result.current.tokens?.bleToken).toBe(MY_BLE_TOKENS[1]);
  });
});
