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
 * Rotas da conexão presencial (contrato em packages/shared: proximity.ts e connections.ts; ADR
 * 0013). Todas só de conta pessoal e sem cache. Nada do aparelho vai para o servidor: só o token lido.
 */

const idPath = (id: string) => encodeURIComponent(id);

/**
 * `POST /proximity/tokens`: o token da emissão (30 s), o mesmo no QR e no NFC (ADR 0013 §1), e a
 * marca de "tela Conectar aberta".
 */
export function issueProximityToken(api: ApiClient): Promise<ProximityToken> {
  return api.request('/v1/proximity/tokens', { method: 'POST', schema: ProximityTokenSchema });
}

/** `POST /proximity/resolve` com o token lido (QR, NFC ou deep link). */
export function resolveProximityToken(
  api: ApiClient,
  token: string,
): Promise<ProximityResolveResult> {
  return api.request('/v1/proximity/resolve', {
    method: 'POST',
    body: { tokens: [token] },
    schema: ProximityResolveResultSchema,
  });
}

/**
 * `POST /connections/requests`: A pede a B, com o token de B lido e o caminho da leitura (`qr` ou
 * `nfc`, ADR 0013 §2).
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
 * `POST .../:id/accept` (D7, ADR 0013 §2): sempre com o token de quem pediu, lido por QR ou NFC na
 * tela "Aguardando" dele.
 */
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

/**
 * `POST /dev/simulate-request` (só existe com `NODE_ENV=development`, 4.11): uma persona pede
 * conexão pelo método escolhido e a rota devolve o token dela, que faz as vezes da leitura no aceite.
 */
export function simulateIncomingRequest(
  api: ApiClient,
  method: ConnectionMethod,
): Promise<SimulatedConnectionRequest> {
  return api.request('/v1/dev/simulate-request', {
    method: 'POST',
    body: { method },
    schema: SimulatedConnectionRequestSchema,
  });
}
