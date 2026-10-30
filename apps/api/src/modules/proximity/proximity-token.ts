import { createHash, randomBytes } from 'node:crypto';

import { PROXIMITY_TOKEN_BYTES } from '@sussurro/shared';

import type { RateLimitRule } from '../../common/rate-limit/rate-limiter.service.js';

/** Token opaco e efêmero: 12 bytes de CSPRNG em base64url = 16 caracteres (ADR 0002 e 0003). */
export function generateProximityToken(): string {
  return randomBytes(PROXIMITY_TOKEN_BYTES).toString('base64url');
}

/** O Redis guarda só o SHA-256 do token (PROX-01): um dump do Redis não revela tokens válidos. */
export function hashProximityToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

const MINUTE = 60_000;

/**
 * Limites da proximidade, por conta (ADR 0003, PROX-20). Diferente dos outros rate limits da API,
 * ficam no `ProximityStore` e falham **fechados**: sem Redis, nada de proximidade (R11).
 */
export const PROXIMITY_LIMITS = {
  // A rotação é a cada 20 s (3 por minuto): sobra folga para reabrir a tela.
  tokens: { name: 'prox-tokens:user', limit: 6, windowMs: MINUTE },
  // Em lote (A-17): o app junta os tokens novos numa chamada a cada 3 s (no máximo 20 por minuto).
  resolve: { name: 'prox-resolve:user', limit: 30, windowMs: MINUTE },
  requestsPerMinute: { name: 'conn-requests:user:min', limit: 10, windowMs: MINUTE },
  requestsPerDay: { name: 'conn-requests:user:day', limit: 50, windowMs: 24 * 60 * MINUTE },
  accepts: { name: 'conn-accepts:user', limit: 10, windowMs: MINUTE },
  // Pedido ou aceite recusado por token (inválido, vencido, de outra pessoa, bloqueio, recusa
  // recente): 20 em 10 min bloqueiam a proximidade inteira, inclusive o QR, por 15 min.
  failures: { name: 'prox-failures:user', limit: 20, windowMs: 10 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;

/** Duração do bloqueio depois de 20 falhas de token (ADR 0003). */
export const PROXIMITY_LOCK_MS = 15 * MINUTE;
