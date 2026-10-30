/** Estado de um refresh token apresentado em `/auth/refresh`. */
export interface PresentedRefreshToken {
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  userDeletedAt: Date | null;
}

/**
 * O que fazer com um refresh apresentado (ADR 0007):
 * - `invalid`: inexistente, revogado, vencido ou de conta excluída → 401 (AUTH-09);
 * - `rotate`: nunca usado → marca como usado e emite o sucessor (AUTH-08);
 * - `retry`: já usado há no máximo `graceMs` → retry de rede: revoga o sucessor e emite outro par;
 * - `reuse`: já usado há mais de `graceMs` → provável roubo: revoga a família inteira e responde 401.
 */
export type RefreshDecision = 'invalid' | 'rotate' | 'retry' | 'reuse';

export function decideRefresh(
  token: PresentedRefreshToken | undefined,
  now: Date,
  graceMs: number,
): RefreshDecision {
  if (token?.revokedAt !== null || token.userDeletedAt !== null) {
    return 'invalid';
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    return 'invalid';
  }
  if (token.usedAt === null) {
    return 'rotate';
  }
  return now.getTime() - token.usedAt.getTime() <= graceMs ? 'retry' : 'reuse';
}
