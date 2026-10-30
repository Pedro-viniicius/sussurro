import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@sussurro/shared';

import { CredentialsRepository } from './credentials.repository.js';
import { EmailTokensRepository } from './email-tokens.repository.js';
import { EMAIL_PATHS, emailLink, verificationEmail } from './emails.js';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { RATE_LIMITS, RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { AppConfig } from '../../config/config.module.js';
import { EmailSender, type EmailMessage } from '../../infra/email/email-sender.js';

export interface VerificationRecipient {
  id: string;
  email: string;
  name: string;
}

/**
 * Confirmação de e-mail (história X.3, D6). O cadastro manda o link; a conta funciona antes da
 * confirmação e o app mostra o aviso para confirmar. O bloqueio parcial (publicar, conectar,
 * seguir) entra com essas rotas nas Fases 2 a 4.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly ttlMs: number;
  private readonly linkBaseUrl: string;

  constructor(
    private readonly tokens: EmailTokensRepository,
    private readonly credentials: CredentialsRepository,
    private readonly sender: EmailSender,
    private readonly rateLimiter: RateLimiterService,
    private readonly clock: Clock,
    config: AppConfig,
  ) {
    this.ttlMs = config.env.EMAIL_VERIFICATION_TTL_S * 1000;
    this.linkBaseUrl = config.env.EMAIL_LINK_BASE_URL;
  }

  /** Cria um link novo (invalida os anteriores) e envia. */
  async issue(recipient: VerificationRecipient): Promise<void> {
    const now = this.clock.now();
    const token = generateOpaqueToken();
    await this.tokens.db.transaction(async (tx) => {
      await this.tokens.invalidateUnused(tx, recipient.id, 'verify_email', now);
      await this.tokens.insert(tx, {
        userId: recipient.id,
        purpose: 'verify_email',
        email: recipient.email,
        tokenHash: hashOpaqueToken(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.ttlMs),
      });
    });
    const link = emailLink(this.linkBaseUrl, EMAIL_PATHS.verifyEmail, token);
    this.dispatch(verificationEmail(recipient.email, recipient.name, link));
  }

  /** Igual a `issue`, mas uma falha não derruba quem chamou (o cadastro já foi gravado). */
  async issueSafely(recipient: VerificationRecipient): Promise<void> {
    try {
      await this.issue(recipient);
    } catch (error) {
      this.logger.error(`Falha ao gerar o link de verificação: ${describeError(error)}`);
    }
  }

  /** `POST /me/email/verification`: reenvia o link (3 por hora). Conta já confirmada: nada a fazer. */
  async resend(auth: AuthContext): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.emailVerificationPerUser, auth.userId);
    const account = await this.credentials.findActiveById(auth.userId);
    // Conta inexistente ou já confirmada: nada a fazer.
    if (account?.emailVerifiedAt !== null) {
      return;
    }
    await this.issue(account);
  }

  /** `POST /auth/email/verify`: link de uso único, dentro da validade (X.3 CA1). */
  async verify(token: string): Promise<void> {
    const now = this.clock.now();
    const verified = await this.tokens.db.transaction(async (tx) => {
      const row = await this.tokens.findUsableForUpdate(
        tx,
        hashOpaqueToken(token),
        'verify_email',
        now,
      );
      if (row === undefined || row.email !== row.currentEmail) {
        return false;
      }
      await this.tokens.markUsed(tx, row.id, now);
      await this.credentials.markEmailVerified(tx, row.userId, now);
      return true;
    });
    if (!verified) {
      throw new DomainError(
        ErrorCode.INVALID_TOKEN,
        400,
        'Link de verificação inválido ou vencido',
      );
    }
  }

  /** Envio sem bloquear a resposta; a falha vai para o log. */
  private dispatch(message: EmailMessage): void {
    void this.sender.send(message).catch((error: unknown) => {
      this.logger.error(`Falha ao enviar e-mail de verificação: ${describeError(error)}`);
    });
  }
}
