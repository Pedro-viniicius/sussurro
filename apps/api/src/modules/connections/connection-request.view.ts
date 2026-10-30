import type { ConnectionRequestRow } from '@sussurro/db';
import type { ConnectionRequest, ConnectionRequestStatus } from '@sussurro/shared';

/** Estado efetivo: um pendente que passou do prazo já é `expired` (expiração preguiçosa). */
export function effectiveStatus(
  request: Pick<ConnectionRequestRow, 'status' | 'expiresAt'>,
  now: Date,
): ConnectionRequestRow['status'] {
  return request.status === 'pending' && request.expiresAt.getTime() <= now.getTime()
    ? 'expired'
    : request.status;
}

/**
 * Estado que cada pessoa vê (ux.md §5.2). Quem pediu vê só `pending`, `accepted` ou
 * `not_confirmed`: recusa, expiração e cancelamento (inclusive pelo logout ou pela exclusão da
 * outra conta) são iguais para ela, então a recusa nunca é revelada (PROX-17). Quem recebeu vê o
 * estado real.
 */
export function visibleStatus(
  request: Pick<ConnectionRequestRow, 'status' | 'expiresAt' | 'fromId'>,
  viewerId: string,
  now: Date,
): ConnectionRequestStatus {
  const status = effectiveStatus(request, now);
  if (request.fromId !== viewerId) {
    return status;
  }
  return status === 'pending' || status === 'accepted' ? status : 'not_confirmed';
}

/** O pedido como `viewerId` o vê, com a outra pessoa já resolvida (avatar assinado). */
export function toConnectionRequestView(
  request: ConnectionRequestRow,
  viewerId: string,
  other: { handle: string; name: string; avatarUrl: string | null },
  now: Date,
): ConnectionRequest {
  const status = visibleStatus(request, viewerId, now);
  const remainingMs = request.expiresAt.getTime() - now.getTime();
  return {
    id: request.id,
    direction: request.fromId === viewerId ? 'outgoing' : 'incoming',
    status,
    method: request.method,
    other,
    createdAt: request.createdAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
    expiresInS: status === 'pending' ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0,
  };
}
