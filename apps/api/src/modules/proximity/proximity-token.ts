import { createHash, randomBytes } from 'node:crypto';

import { PROXIMITY_TOKEN_BYTES, PROXIMITY_TOUCH_LIMIT_PER_MIN } from '@sussurro/shared';

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
const DAY = 24 * 60 * MINUTE;

/**
 * Limites da proximidade, por conta (ADR 0003, PROX-20; ADR 0012 §6). Diferente dos outros rate
 * limits da API, ficam no `ProximityStore` e falham **fechados**: sem Redis, nada de proximidade
 * (R11). Exceção: o sinal de abuso `blockAfterTouch` falha **aberto** (o bloqueio nunca depende do
 * Redis, ADR 0012 A2-3). O teto de pessoas novas (A2-1) vem do env e roda no script do casamento.
 */
export const PROXIMITY_LIMITS = {
  // A rotação é a cada 20 s (3 por minuto): sobra folga para reabrir a tela. Cada emissão traz os
  // dois tokens (BLE e QR).
  tokens: { name: 'prox-tokens:user', limit: 6, windowMs: MINUTE },
  // (ADR 0012) Só o QR: uma chamada por código lido.
  resolve: { name: 'prox-resolve:user', limit: 30, windowMs: MINUTE },
  // (ADR 0012) Relato do encosto: o app manda 1 por segundo, um por vez. (ADR 0012, A3-8, item 1)
  // No pior caso, 51 inícios por admissão sem alternância, e até 56 em 60 s com uma rede que
  // alterna (cada 200 que encerra uma sequência de falhas depois de ≥ 5 s sem aceite estende o
  // prazo de novo): sempre abaixo deste limite. Nunca conta como falha (não ser mútuo é normal).
  // (R1-4) A primeira entrega do cartão devido sai antes deste limite: não conta nem dá 429.
  // (ADR 0012, A3-2) A reentrega, por até 10 s depois dela, conta, e acima do limite dá 429.
  touches: { name: 'prox-touches:user', limit: PROXIMITY_TOUCH_LIMIT_PER_MIN, windowMs: MINUTE },
  requestsPerMinute: { name: 'conn-requests:user:min', limit: 10, windowMs: MINUTE },
  requestsPerDay: { name: 'conn-requests:user:day', limit: 50, windowMs: 24 * 60 * MINUTE },
  accepts: { name: 'conn-accepts:user', limit: 10, windowMs: MINUTE },
  // Pedido ou aceite recusado por token (inválido, vencido, de outra pessoa, bloqueio, recusa
  // recente e, desde a ADR 0012, pedido `ble` sem o par encostado e token do canal trocado): 20 em
  // 10 min bloqueiam a proximidade inteira, inclusive o QR, por 15 min.
  failures: { name: 'prox-failures:user', limit: 20, windowMs: 10 * MINUTE },
  // (A2-3) Bloqueio gravado entre duas contas com par encostado vivo (até 60 s depois do último
  // casamento): um contador por papel, `rl:prox-block-after-touch:{blocker|blocked}:{uid}`, em
  // janela fixa de 7 dias. No 3º, um e-mail para a moderação (só números no Redis, sem a outra
  // parte). (A2 rev. 1, R1-6) Conta no máximo uma vez por casamento e por sentido
  // (`countBlockSignal`): os contadores contam bloqueios, não pessoas.
  blockAfterTouch: { name: 'prox-block-after-touch', limit: 3, windowMs: 7 * DAY },
} as const satisfies Record<string, RateLimitRule>;

/** Duração do bloqueio depois de 20 falhas de token (ADR 0003). */
export const PROXIMITY_LOCK_MS = 15 * MINUTE;
