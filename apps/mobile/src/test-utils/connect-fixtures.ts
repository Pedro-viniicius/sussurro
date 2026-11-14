import type { ConnectionRequest, NearbyPerson, ProximityToken } from '@sussurro/shared';

import type { FakeApi, FakeCall, FakeReply } from './fake-api';

/** Fixtures da Fase 4 (ADR 0013, NFC e QR code), no formato exato dos schemas de packages/shared. */

/** Os meus tokens (o mesmo no QR e no NFC), na ordem das emissões. */
export const MY_TOKENS = ['MyTokenAAAAAAAA1', 'MyTokenAAAAAAAA2', 'MyTokenAAAAAAAA3'] as const;
/** Os tokens das pessoas (lidos por QR ou NFC). */
export const CAIO_TOKEN = 'CaioTokenBBBBBB1';
export const BIA_TOKEN = 'BiaTokenCCCCCCC1';
export const HELENA_TOKEN = 'HelenaTokenDDDD1';
/** O token que a rota de simulação devolve (a persona). */
export const LUCAS_TOKEN = 'LucasTokenFFFFF1';

export function proximityToken(index = 0): ProximityToken {
  return {
    token: MY_TOKENS[Math.min(index, MY_TOKENS.length - 1)] ?? MY_TOKENS[0],
    expiresAt: '2026-10-30T12:00:30.000Z',
    renewInS: 20,
  };
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
    method: 'qr',
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

/** As pessoas que o `resolve` falso conhece, pelo token. */
export const PEOPLE: Readonly<Record<string, NearbyPerson>> = {
  [CAIO_TOKEN]: nearbyPerson(),
  [BIA_TOKEN]: nearbyPerson({ token: BIA_TOKEN, handle: 'bia.alves', name: 'Bianca Alves' }),
  [HELENA_TOKEN]: nearbyPerson({ token: HELENA_TOKEN, handle: 'helena', name: 'Helena Souza' }),
};

/** `POST /proximity/resolve`: uma linha por token conhecido; o resto não aparece (PROX-05). */
export function resolver(people: Readonly<Record<string, NearbyPerson>> = PEOPLE) {
  return ({ body }: FakeCall): FakeReply => {
    const tokens = (body as { tokens: string[] }).tokens;
    const items = tokens.flatMap((token) => {
      const person = people[token];
      return person === undefined ? [] : [person];
    });
    return { status: 200, body: { items } };
  };
}

/**
 * Respostas padrão da tela Conectar: cada pedido de token devolve a próxima emissão da lista (a
 * última se repete), o `resolve` conhece `PEOPLE` e a caixa de entrada vem vazia. `configure` do
 * teste pode trocar.
 */
export function configureConnect(api: FakeApi) {
  let issued = 0;
  api.on('POST /v1/proximity/tokens', () => {
    const body = proximityToken(issued);
    issued += 1;
    return { status: 201, body };
  });
  api.on('POST /v1/proximity/resolve', resolver());
  api.on('GET /v1/connections/requests/incoming', { status: 200, body: { items: [] } });
}
