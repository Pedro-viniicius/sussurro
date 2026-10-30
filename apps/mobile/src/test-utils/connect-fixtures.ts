import type { ConnectionRequest, NearbyPerson, ProximityToken } from '@sussurro/shared';

import type { FakeApi, FakeReply } from './fake-api';

/** Fixtures da Fase 4 (formato exato dos schemas de packages/shared). */

export const MY_TOKENS = ['MyTokenAAAAAAAA1', 'MyTokenAAAAAAAA2', 'MyTokenAAAAAAAA3'] as const;
export const CAIO_TOKEN = 'CaioTokenBBBBBB1';
export const CAIO_TOKEN_2 = 'CaioTokenBBBBBB2';
export const BIA_TOKEN = 'BiaTokenCCCCCCC1';
export const HELENA_TOKEN = 'HelenaTokenDDDD1';

export function proximityToken(token: string = MY_TOKENS[0]): ProximityToken {
  return { token, expiresAt: '2026-10-30T12:00:30.000Z', renewInS: 20 };
}

export function nearbyPerson(overrides: Partial<NearbyPerson> = {}): NearbyPerson {
  return {
    token: CAIO_TOKEN,
    handle: 'caio.r',
    name: 'Caio Ribeiro',
    avatarUrl: null,
    alreadyConnected: false,
    ...overrides,
  };
}

export function connectionRequest(overrides: Partial<ConnectionRequest> = {}): ConnectionRequest {
  return {
    id: '01a189e0-af57-7000-85fe-2054e618fe01',
    direction: 'outgoing',
    status: 'pending',
    method: 'ble',
    other: { handle: 'caio.r', name: 'Caio Ribeiro', avatarUrl: null },
    createdAt: '2026-10-30T12:00:00.000Z',
    expiresAt: '2026-10-30T12:02:00.000Z',
    expiresInS: 120,
    ...overrides,
  };
}

export function incomingRequest(overrides: Partial<ConnectionRequest> = {}): ConnectionRequest {
  return connectionRequest({
    id: '01a189e0-af57-7000-85fe-2054e618fe02',
    direction: 'incoming',
    other: { handle: 'helena', name: 'Helena Souza', avatarUrl: null },
    ...overrides,
  });
}

export function apiError(status: number, code: string): FakeReply {
  return { status, body: { code, message: code } };
}

/**
 * Respostas padrão da tela Conectar: cada pedido de token devolve o próximo da lista (o último se
 * repete) e a caixa de entrada vem vazia. `configure` do teste pode trocar.
 */
export function configureConnect(api: FakeApi, tokens: readonly string[] = MY_TOKENS) {
  let issued = 0;
  api.on('POST /v1/proximity/tokens', () => {
    const token = tokens[Math.min(issued, tokens.length - 1)] ?? MY_TOKENS[0];
    issued += 1;
    return { status: 201, body: proximityToken(token) };
  });
  api.on('GET /v1/connections/requests/incoming', { status: 200, body: { items: [] } });
}
