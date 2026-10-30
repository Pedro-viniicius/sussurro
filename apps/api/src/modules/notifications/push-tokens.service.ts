import { Injectable, Logger } from '@nestjs/common';
import type { DbExecutor } from '@sussurro/db';
import {
  MAX_PUSH_TOKENS_PER_ACCOUNT,
  type RegisterPushTokenRequest,
  type RemovePushTokenRequest,
} from '@sussurro/shared';

import { PushTokensRepository } from './push-tokens.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { RATE_LIMITS, RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';

/**
 * Push tokens do Expo (história 6.4; ADR 0011). As rotas mexem só nos tokens de quem chama (CA3); o
 * logout tira o token daquele aparelho (AUTH-12, CA2) e a exclusão de conta tira todos.
 */
@Injectable()
export class PushTokensService {
  private readonly logger = new Logger(PushTokensService.name);

  constructor(
    private readonly tokens: PushTokensRepository,
    private readonly rateLimiter: RateLimiterService,
    private readonly clock: Clock,
  ) {}

  /**
   * `PUT /me/push-tokens` (204, idempotente). O token fica ligado à sessão do access token
   * (`fam`). No máximo 10 por conta: o mais antigo sai. Token ativo de outra conta: nada muda, e a
   * resposta é a mesma (sem revelar a quem ele pertence).
   */
  async register(auth: AuthContext, input: RegisterPushTokenRequest): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.pushTokensPerUser, auth.userId);
    const outcome = await this.tokens.db.transaction(async (tx) => {
      const result = await this.tokens.register(tx, {
        userId: auth.userId,
        familyId: auth.familyId,
        expoToken: input.expoToken,
        platform: input.platform,
        now: this.clock.now(),
      });
      if (result !== 'kept') {
        await this.tokens.trimToLimit(tx, auth.userId, MAX_PUSH_TOKENS_PER_ACCOUNT);
      }
      return result;
    });
    if (outcome === 'kept') {
      this.logger.warn('Push token já ativo em outra conta: registro ignorado (6.4 CA3)');
    }
  }

  /** `DELETE /me/push-tokens` (204): só o token de quem chama (o de outra conta não muda). */
  async remove(auth: AuthContext, input: RemovePushTokenRequest): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.pushTokensPerUser, auth.userId);
    await this.tokens.removeOwn(auth.userId, input.expoToken);
  }

  /** Logout deste aparelho e família revogada por reuso, na mesma transação da revogação. */
  removeFamily(executor: DbExecutor, userId: string, familyId: string): Promise<void> {
    return this.tokens.removeFamily(executor, userId, familyId);
  }

  /** Todas as sessões revogadas (sair de todos, troca de senha, exclusão de conta). */
  removeAllForUser(executor: DbExecutor, userId: string): Promise<void> {
    return this.tokens.removeAllForUser(executor, userId);
  }
}
