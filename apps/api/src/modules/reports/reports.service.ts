import { Injectable, Logger } from '@nestjs/common';
import { type CreateReportRequest, ErrorCode, type ReportTarget } from '@sussurro/shared';

import { moderationEmail, type ReportedTarget } from './moderation-email.js';
import { ReportsRepository } from './reports.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { RATE_LIMITS, RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { AppConfig } from '../../config/config.module.js';
import { EmailSender } from '../../infra/email/email-sender.js';
import { CommentsService } from '../comments/comments.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';
import { PostsService } from '../posts/posts.service.js';
import { ProximityService } from '../proximity/proximity.service.js';
import { profileNotFound, UsersService } from '../users/users.service.js';

/** Fora de produção, sem `MODERATION_EMAIL`: o e-mail só aparece no log (`EMAIL_SENDER=log`). */
export const DEV_MODERATION_EMAIL = 'moderacao@example.com';

const commentNotFound = () =>
  new DomainError(ErrorCode.NOT_FOUND, 404, 'Comentário não encontrado');

const cannotReportSelf = () =>
  new DomainError(ErrorCode.VALIDATION_ERROR, 400, 'Entrada inválida', [
    { path: 'target', message: 'Não é possível denunciar a própria conta ou o próprio conteúdo.' },
  ]);

interface ResolvedTarget extends ReportedTarget {
  accountId: string;
}

/**
 * Denúncias (X.1, D5). Só se denuncia o que se vê: post, comentário ou perfil que a pessoa não vê
 * (ou que não existe) → o mesmo 404 de inexistente, pelas mesmas regras do `AccessPolicyService`.
 * (ADR 0012, A2 rev. 1, R1-5) A conta também pode ser denunciada por quem encostou nela há até
 * 60 s (o par encostado vivo; o cartão do encosto já mostrou o @), mesmo sem ver o perfil. Com alvo
 * não visível, a regra consulta o par no Valkey sempre: fora do ar, 503 `PROXIMITY_UNAVAILABLE`,
 * igual para qualquer @, e nada é gravado nem enviado.
 * A pessoa denunciada nunca é avisada. Repetir a denúncia do mesmo alvo devolve o mesmo 202, sem
 * linha nova nem outro e-mail. Cada denúncia nova manda um e-mail para a moderação.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private readonly moderationAddress: string;

  constructor(
    private readonly reports: ReportsRepository,
    private readonly posts: PostsService,
    private readonly comments: CommentsService,
    private readonly users: UsersService,
    private readonly policy: AccessPolicyService,
    private readonly proximity: ProximityService,
    private readonly sender: EmailSender,
    private readonly rateLimiter: RateLimiterService,
    private readonly clock: Clock,
    config: AppConfig,
  ) {
    this.moderationAddress = config.env.MODERATION_EMAIL ?? DEV_MODERATION_EMAIL;
  }

  async create(viewer: AuthContext, input: CreateReportRequest): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.reportsPerUser, viewer.userId);
    const target = await this.resolveTarget(viewer, input.target);
    if (target.accountId === viewer.userId) {
      throw cannotReportSelf();
    }
    const now = this.clock.now();
    const id = await this.reports.insert({
      reporterId: viewer.userId,
      targetType: target.type,
      targetUserId: target.accountId,
      postId: target.type === 'post' ? (target.contentId ?? null) : null,
      commentId: target.type === 'comment' ? (target.contentId ?? null) : null,
      reason: input.reason,
      details: input.details,
      createdAt: now,
    });
    if (id === undefined) {
      return;
    }
    this.dispatch(
      moderationEmail(this.moderationAddress, {
        id,
        target,
        reason: input.reason,
        details: input.details,
        createdAt: now,
      }),
    );
  }

  private async resolveTarget(viewer: AuthContext, target: ReportTarget): Promise<ResolvedTarget> {
    switch (target.type) {
      case 'post': {
        // Visível e publicado (PERM-14); senão, o 404 de publicação inexistente.
        const post = await this.posts.findInteractable(viewer, target.id);
        return {
          type: 'post',
          contentId: post.id,
          accountId: post.authorId,
          accountHandle: post.authorHandle,
        };
      }
      case 'comment': {
        const comment = await this.comments.findVisibleComment(viewer, target.id);
        if (comment === undefined) {
          throw commentNotFound();
        }
        return {
          type: 'comment',
          contentId: comment.id,
          accountId: comment.authorId,
          accountHandle: comment.authorHandle,
        };
      }
      case 'account': {
        // Perfil visível ou par encostado vivo (R1-5); senão, o mesmo 404 de @ inexistente.
        const account = await this.users.findActiveAccount(target.handle);
        const allowed = await this.policy.canBlockOrReport(viewer, account, (targetId) =>
          this.proximity.hasLiveTouchPair(viewer.userId, targetId),
        );
        if (account === undefined || !allowed) {
          throw profileNotFound();
        }
        return { type: 'account', accountId: account.id, accountHandle: account.handle };
      }
    }
  }

  /** Envio sem bloquear a resposta; a falha vai para o log (a denúncia já está gravada). */
  private dispatch(message: ReturnType<typeof moderationEmail>): void {
    void this.sender.send(message).catch((error: unknown) => {
      this.logger.error(`Falha ao enviar o e-mail de moderação: ${describeError(error)}`);
    });
  }
}
