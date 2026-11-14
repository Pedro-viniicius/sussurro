import { Injectable } from '@nestjs/common';
import {
  type BlockRequest,
  ErrorCode,
  isValidHandleFormat,
  normalizeHandle,
} from '@sussurro/shared';

import { BlocksRepository } from './blocks.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { lockAccountPair } from '../../common/db/pair-lock.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { RATE_LIMITS, RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { CommentsService } from '../comments/comments.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';
import { UsersService } from '../users/users.service.js';

const cannotBlockSelf = () =>
  new DomainError(ErrorCode.VALIDATION_ERROR, 400, 'Entrada inválida', [
    { path: '', message: 'Não é possível bloquear a própria conta.' },
  ]);

/**
 * Bloquear e desbloquear (X.2, D5). O efeito na visibilidade (perfil, posts, comentários, busca e
 * seguir, nos dois sentidos) fica todo no `AccessPolicyService`; aqui só se grava o bloqueio e se
 * desfazem as relações do par.
 *
 * Sem oráculo de existência de @ pessoal: o bloqueio só é gravado para quem a pessoa já pode ver
 * (perfil visível pela política, a outra pessoa de um pedido de conexão das últimas 24 h, ADR 0013,
 * ou o autor de um comentário que ela vê, D11). Para @ inexistente, conta excluída ou perfil que ela
 * não vê, nada é gravado e a resposta é o mesmo 204 do sucesso; a lista de bloqueados só mostra
 * contas que ela já conhecia.
 */
@Injectable()
export class BlocksService {
  constructor(
    private readonly blocks: BlocksRepository,
    private readonly users: UsersService,
    private readonly comments: CommentsService,
    private readonly policy: AccessPolicyService,
    private readonly rateLimiter: RateLimiterService,
    private readonly notifications: NotificationsService,
    private readonly clock: Clock,
  ) {}

  /**
   * `POST /me/blocks` → 204 sempre (para um corpo válido). Na mesma transação: o bloqueio, a
   * conexão e os follows do par desfeitos (X.2 CA3) e os comentários de cada um nos posts do outro
   * apagados, com os contadores ajustados.
   */
  async block(viewer: AuthContext, input: BlockRequest): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.blocksPerUser, viewer.userId);
    const targetId = await this.resolveTarget(viewer, input);
    if (targetId === undefined) {
      return;
    }
    const now = this.clock.now();
    await this.blocks.db.transaction(async (tx) => {
      // Mesma trava de seguir e de conectar: nada do par sobrevive ao bloqueio.
      await lockAccountPair(tx, viewer.userId, targetId);
      await this.blocks.insert(tx, viewer.userId, targetId, now);
      await this.blocks.removeRelations(tx, viewer.userId, targetId, now);
      await this.comments.removeBetween(tx, viewer.userId, targetId, now);
      // Fase 6: as notificações entre os dois somem (a leitura também as esconde, X.2).
      await this.notifications.removeBetween(tx, viewer.userId, targetId);
    });
  }

  /** `DELETE /me/blocks/:handle` → 204 sempre. Volta a visibilidade, não as relações desfeitas. */
  async unblock(viewer: AuthContext, rawHandle: string): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.blocksPerUser, viewer.userId);
    const handle = normalizeHandle(rawHandle);
    if (!isValidHandleFormat(handle)) {
      return;
    }
    await this.blocks.deleteByHandle(viewer.userId, handle);
  }

  /**
   * Id da conta a bloquear, ou `undefined` quando a pessoa não a vê (nada é gravado).
   */
  private async resolveTarget(
    viewer: AuthContext,
    input: BlockRequest,
  ): Promise<string | undefined> {
    if ('commentId' in input) {
      const comment = await this.comments.findVisibleComment(viewer, input.commentId);
      if (comment?.authorId === viewer.userId) {
        throw cannotBlockSelf();
      }
      return comment?.authorId;
    }
    const account = await this.users.findActiveAccount(input.handle);
    if (account?.id === viewer.userId) {
      throw cannotBlockSelf();
    }
    const allowed = await this.policy.canBlockOrReport(viewer, account);
    return allowed ? account?.id : undefined;
  }
}
