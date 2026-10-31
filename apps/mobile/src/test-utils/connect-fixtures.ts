import type {
  ConnectionRequest,
  NearbyPerson,
  ProximityToken,
  ProximityTouchItem,
} from '@sussurro/shared';

import type { FakeApi, FakeCall, FakeReply } from './fake-api';

/** Fixtures da Fase 4 e do "encostar" (ADR 0012), no formato exato dos schemas de packages/shared. */

/** Os meus `bleToken` (vão no anúncio), na ordem das emissões. */
export const MY_BLE_TOKENS = ['MyBleTokenAAAAA1', 'MyBleTokenAAAAA2', 'MyBleTokenAAAAA3'] as const;
/** Os meus `qrToken` (vão no QR), na ordem das emissões. */
export const MY_QR_TOKENS = ['MyQrTokenAAAAAA1', 'MyQrTokenAAAAAA2', 'MyQrTokenAAAAAA3'] as const;
/** O `bleToken` de Caio (visto no anúncio) e os `qrToken` das pessoas (lidos do QR). */
export const CAIO_TOKEN = 'CaioTokenBBBBBB1';
export const CAIO_TOKEN_2 = 'CaioTokenBBBBBB2';
export const BIA_TOKEN = 'BiaTokenCCCCCCC1';
export const HELENA_TOKEN = 'HelenaTokenDDDD1';

export function proximityToken(index = 0): ProximityToken {
  return {
    bleToken: MY_BLE_TOKENS[Math.min(index, MY_BLE_TOKENS.length - 1)] ?? MY_BLE_TOKENS[0],
    qrToken: MY_QR_TOKENS[Math.min(index, MY_QR_TOKENS.length - 1)] ?? MY_QR_TOKENS[0],
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
 * Respostas padrão da tela Conectar: cada pedido de tokens devolve a próxima emissão da lista (a
 * última se repete) e a caixa de entrada vem vazia. `configure` do teste pode trocar.
 */
export function configureConnect(api: FakeApi) {
  let issued = 0;
  api.on('POST /v1/proximity/tokens', () => {
    const body = proximityToken(issued);
    issued += 1;
    return { status: 201, body };
  });
  api.on('GET /v1/connections/requests/incoming', { status: 200, body: { items: [] } });
}

/** `pairExpiresInS` do casamento na hora: 60 s arredondados para baixo em múltiplos de 5 s. */
export const PAIR_EXPIRES_IN_S = 55;

/**
 * Um cartão do `touches` (A2 rev. 1, PROX-64): a pessoa e o `pairExpiresInS`, o que falta para o
 * par vencer no servidor (padrão: 55, como no casamento na hora).
 */
export function touchItem(
  person: NearbyPerson | ProximityTouchItem = nearbyPerson(),
  pairExpiresInS = PAIR_EXPIRES_IN_S,
): ProximityTouchItem {
  return { pairExpiresInS, ...person };
}

/**
 * `POST /proximity/touches` com o encosto mútuo: o 1º relato de um token devolve `[]` (o outro
 * celular ainda não relatou) e os seguintes, o cartão de `people[token]` (revelação simétrica),
 * com o `pairExpiresInS` dele (sem o campo, 60 s). Token sem pessoa: sempre `[]`.
 */
export function mutualTouches(
  people: Readonly<Record<string, NearbyPerson | ProximityTouchItem>>,
  firstEmpty = 1,
) {
  const seen = new Map<string, number>();
  return ({ body }: FakeCall): FakeReply => {
    const [token = ''] = (body as { tokens: string[] }).tokens;
    const count = (seen.get(token) ?? 0) + 1;
    seen.set(token, count);
    const person = people[token];
    return {
      status: 200,
      body: { items: person !== undefined && count > firstEmpty ? [touchItem(person)] : [] },
    };
  };
}
