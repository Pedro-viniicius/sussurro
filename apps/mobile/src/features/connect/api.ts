import {
  type ConnectionMethod,
  type ConnectionRequest,
  ConnectionRequestSchema,
  type IncomingConnectionRequests,
  IncomingConnectionRequestsSchema,
  NoContentSchema,
  type ProximityResolveResult,
  ProximityResolveResultSchema,
  type ProximityToken,
  ProximityTokenSchema,
  type ProximityTouchResult,
  ProximityTouchResultSchema,
  type SimulatedConnectionRequest,
  SimulatedConnectionRequestSchema,
  type SimulatedTouch,
  SimulatedTouchSchema,
} from '@sussurro/shared';

import type { ApiClient } from '../../lib/api/client';

/**
 * Rotas da conexão presencial (contrato em packages/shared: proximity.ts e connections.ts; ADR
 * 0012). Todas só de conta pessoal e sem cache. O RSSI, a potência e o modelo do aparelho nunca
 * vão para o servidor: o `touches` recebe só o token encostado (PROX-43).
 */

const idPath = (id: string) => encodeURIComponent(id);

/**
 * `POST /proximity/tokens`: os dois tokens da emissão (30 s) e a marca de "tela Conectar aberta".
 * O `bleToken` só vai no anúncio; o `qrToken` só no QR (ADR 0012 §1).
 */
export function issueProximityTokens(api: ApiClient): Promise<ProximityToken> {
  return api.request('/v1/proximity/tokens', { method: 'POST', schema: ProximityTokenSchema });
}

/**
 * `POST /proximity/touches` com **um** token: o `bleToken` encostado de menor perda (P8). O cartão
 * só volta com o encosto mútuo (ADR 0012 §3). Nada além do token vai no corpo. É a única chamada com
 * prazo (`timeoutMs`, o `reportTimeoutMs` de 4 s; A3-3 item 1): uma conexão que trava prenderia o
 * relato em voo, e o portão do relato é do processo inteiro.
 */
export function reportTouch(
  api: ApiClient,
  bleToken: string,
  timeoutMs: number,
): Promise<ProximityTouchResult> {
  return api.request('/v1/proximity/touches', {
    method: 'POST',
    body: { tokens: [bleToken] },
    schema: ProximityTouchResultSchema,
    timeoutMs,
  });
}

/** `POST /proximity/resolve` com o `qrToken` lido de um QR (o `resolve` só serve ao QR). */
export function resolveQrToken(api: ApiClient, qrToken: string): Promise<ProximityResolveResult> {
  return api.request('/v1/proximity/resolve', {
    method: 'POST',
    body: { tokens: [qrToken] },
    schema: ProximityResolveResultSchema,
  });
}

/**
 * `POST /connections/requests`: A pede a B. Encostando (`ble`), com o `bleToken` de B devolvido no
 * cartão; pelo QR, com o `qrToken` lido do QR de B.
 */
export function createConnectionRequest(
  api: ApiClient,
  targetToken: string,
  method: ConnectionMethod,
): Promise<ConnectionRequest> {
  return api.request('/v1/connections/requests', {
    method: 'POST',
    body: { targetToken, method },
    schema: ConnectionRequestSchema,
  });
}

/** `GET /connections/requests/incoming`: pendentes para mim, do mais antigo ao mais novo. */
export function fetchIncomingRequests(api: ApiClient): Promise<IncomingConnectionRequests> {
  return api.request('/v1/connections/requests/incoming', {
    schema: IncomingConnectionRequestsSchema,
  });
}

/** `GET /connections/requests/:id`: o estado do meu pedido ("Aguardando"). */
export function fetchConnectionRequest(api: ApiClient, id: string): Promise<ConnectionRequest> {
  return api.request(`/v1/connections/requests/${idPath(id)}`, {
    schema: ConnectionRequestSchema,
  });
}

/**
 * `POST .../:id/accept`. Pedido por encostar (`ble`): corpo vazio (o par encostado já prova o
 * encontro). Pedido por QR (D7): o `qrToken` lido do QR de quem pediu.
 */
export function acceptConnectionRequest(
  api: ApiClient,
  id: string,
  observedToken?: string,
): Promise<ConnectionRequest> {
  return api.request(`/v1/connections/requests/${idPath(id)}/accept`, {
    method: 'POST',
    body: observedToken === undefined ? {} : { observedToken },
    schema: ConnectionRequestSchema,
  });
}

/** `POST .../:id/decline`: só quem recebeu. Quem pediu nunca sabe da recusa. */
export function declineConnectionRequest(api: ApiClient, id: string): Promise<ConnectionRequest> {
  return api.request(`/v1/connections/requests/${idPath(id)}/decline`, {
    method: 'POST',
    schema: ConnectionRequestSchema,
  });
}

/** `DELETE .../:id`: "Cancelar pedido" (só quem pediu). */
export function cancelConnectionRequest(api: ApiClient, id: string): Promise<ConnectionRequest> {
  return api.request(`/v1/connections/requests/${idPath(id)}`, {
    method: 'DELETE',
    schema: ConnectionRequestSchema,
  });
}

/** `DELETE /connections/:handle`: desfazer conexão (D8). A outra pessoa não é avisada. */
export function removeConnection(api: ApiClient, handle: string): Promise<undefined> {
  return api.request(`/v1/connections/${encodeURIComponent(handle)}`, {
    method: 'DELETE',
    schema: NoContentSchema,
  });
}

/** `POST /dev/simulate-request` (só existe com `NODE_ENV=development`, 4.11). */
export function simulateIncomingRequest(api: ApiClient): Promise<SimulatedConnectionRequest> {
  return api.request('/v1/dev/simulate-request', {
    method: 'POST',
    body: {},
    schema: SimulatedConnectionRequestSchema,
  });
}

/**
 * `POST /dev/simulate-touch` (só com `NODE_ENV=development`, ADR 0012 §7): uma persona "encosta"
 * na conta logada e a rota devolve o `bleToken` dela, que o app relata em `touches` na hora. O
 * servidor só casa se o relato chegar dentro da janela (`PROXIMITY_TOUCH_WINDOW_S`, 5 s), contada da
 * observação que a simulação grava e sem renovar (A2-2).
 */
export function simulateTouch(api: ApiClient): Promise<SimulatedTouch> {
  return api.request('/v1/dev/simulate-touch', {
    method: 'POST',
    body: {},
    schema: SimulatedTouchSchema,
  });
}
