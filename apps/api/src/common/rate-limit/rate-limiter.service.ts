import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@sussurro/shared';

import { RateLimitStore } from './rate-limit.store.js';
import { withTimeout } from '../async/with-timeout.js';
import { describeError } from '../errors/describe-error.js';
import { DomainError } from '../errors/domain-error.js';

export interface RateLimitRule {
  name: string;
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Limites de abuso (ADR 0007, arquitetura.md §10, A-05). */
export const RATE_LIMITS = {
  loginPerIp: { name: 'login:ip', limit: 20, windowMs: MINUTE },
  loginPerIpAndEmail: { name: 'login:ip-email', limit: 5, windowMs: MINUTE },
  registerPerIp: { name: 'register:ip', limit: 5, windowMs: HOUR },
  passwordForgotPerIp: { name: 'password-forgot:ip', limit: 10, windowMs: HOUR },
  passwordForgotPerEmail: { name: 'password-forgot:email', limit: 3, windowMs: HOUR },
  emailVerificationPerUser: { name: 'email-verification:user', limit: 3, windowMs: HOUR },
  accountDeletionPerUser: { name: 'account-deletion:user', limit: 5, windowMs: MINUTE },
  // Fase 2: upload (PROJETO.md §4, arquitetura.md R10). Conta cada URL pré-assinada emitida.
  draftsPerUser: { name: 'drafts:user', limit: 20, windowMs: HOUR },
  avatarUploadsPerUser: { name: 'avatar-upload:user', limit: 10, windowMs: HOUR },
  // Fase 5: rascunhos de reel (R10, custo do MediaConvert e do CDN), além do limite de rascunhos.
  reelDraftsPerUser: { name: 'reel-drafts:user', limit: 10, windowMs: HOUR },
  // Fase 3. Busca (A-31): 60/min por conta. Com o app chamando só a partir de 3 letras e com
  // debounce, digitar um @ inteiro gasta menos de 10; varrer todos os criadores fica caro.
  searchPerUser: { name: 'search:user', limit: 60, windowMs: MINUTE },
  // Seguir e deixar de seguir somam no mesmo contador (3.3 CA5).
  followsPerUser: { name: 'follows:user', limit: 10, windowMs: MINUTE },
  // Bloquear e desbloquear: folga para bloquear várias contas de uma vez (ataque em comentários).
  blocksPerUser: { name: 'blocks:user', limit: 60, windowMs: HOUR },
  // Denúncias: cada uma manda um e-mail para a moderação.
  reportsPerUser: { name: 'reports:user', limit: 20, windowMs: HOUR },
  // Fase 6: registrar e apagar push tokens (o app registra a cada abertura; folga para trocas).
  pushTokensPerUser: { name: 'push-tokens:user', limit: 30, windowMs: HOUR },
} as const satisfies Record<string, RateLimitRule>;

/** Tempo máximo esperando o Redis antes de deixar passar (fail-open, R11). */
export const RATE_LIMIT_TIMEOUT_MS = 250;

/** E-mails entram na chave como hash (sem dado pessoal no Redis). */
export function rateLimitSubject(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 32);
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(private readonly store: RateLimitStore) {}

  /**
   * Conta uma tentativa e lança 429 `RATE_LIMITED` (com `retryAfterS`) acima do limite. Se o
   * Redis falhar ou demorar, deixa passar e registra no log: a autenticação não depende do Redis
   * (arquitetura.md R11).
   */
  async consume(rule: RateLimitRule, subject: string): Promise<void> {
    const key = `rl:${rule.name}:${subject}`;
    let hit;
    try {
      hit = await withTimeout(this.store.hit(key, rule.windowMs), RATE_LIMIT_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(`Rate limit ${rule.name} indisponível (liberado): ${describeError(error)}`);
      return;
    }
    if (hit.count > rule.limit) {
      throw new DomainError(ErrorCode.RATE_LIMITED, 429, `Limite ${rule.name} excedido`, {
        retryAfterS: Math.max(1, Math.ceil(hit.resetInMs / 1000)),
      });
    }
  }
}
