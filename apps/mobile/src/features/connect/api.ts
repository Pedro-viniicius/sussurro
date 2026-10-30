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
  type SimulatedConnectionRequest,
  SimulatedConnectionRequestSchema,
} from '@sussurro/shared';

import type { ApiClient } from '../../lib/api/client';

/**
 * Rotas da Fase 4 (contrato em packages/shared: proximity.ts e connections.ts). Todas só de conta
 * pessoal e sem cache. O RSSI nunca vai para o servidor: o `resolve` recebe só os tokens.
 */

const idPath = (id: string) => encodeURIComponent(id);

/** `POST /proximity/tokens`: token novo (30 s) e a marca de "tela Conectar aberta". */
export function issueProximityToken(api: ApiClient): Promise<ProximityToken> {
  return api.request('/v1/proximity/tokens', { method: 'POST', schema: ProximityTokenSchema });
}

/** `POST /proximity/resolve` com 1 a 20 tokens vistos por perto (ou lidos de um QR). */
export function resolveTokens(
  api: ApiClient,
  tokens: readonly string[],
): Promise<ProximityResolveResult> {
  return api.request('/v1/proximity/resolve', {
    method: 'POST',
    body: { tokens },
    schema: ProximityResolveResultSchema,
  });
}

/** `POST /connections/requests`: A pede a B com o token de B (BLE ou QR). */
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

/** `POST .../:id/accept` com o token de A que eu observei (BLE) ou li do QR de A (D7). */
export function acceptConnectionRequest(
  api: ApiClient,
  id: string,
  observedToken: string,
): Promise<ConnectionRequest> {
  return api.request(`/v1/connections/requests/${idPath(id)}/accept`, {
    method: 'POST',
    body: { observedToken },
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
