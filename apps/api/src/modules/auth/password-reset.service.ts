import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode, isWeakPassword } from '@sussurro/shared';

import { CredentialsRepository } from './credentials.repository.js';
import { EmailTokensRepository } from './email-tokens.repository.js';
import { EMAIL_PATHS, emailLink, passwordResetEmail } from './emails.js';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionsService } from './sessions.service.js';
import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  RATE_LIMITS,
  RateLimiterService,
  rateLimitSubject,
} from '../../common/rate-limit/rate-limiter.service.js';
import { AppConfig } from '../../config/config.module.js';
import { EmailSender } from '../../infra/email/email-sender.js';

/** "Esqueci a senha" (história 1.10, D6). */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly ttlMs: number;
  private readonly linkBaseUrl: string;

  constructor(
    private readonly tokens: EmailTokensRepository,
    private readonly credentials: CredentialsRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionsService,
    private readonly sender: EmailSender,
    private readonly rateLimiter: RateLimiterService,
    private readonly clock: Clock,
    config: AppConfig,
  ) {
    this.ttlMs = config.env.PASSWORD_RESET_TTL_S * 1000;
    this.linkBaseUrl = config.env.EMAIL_LINK_BASE_URL;
  }

  /**
   * `POST /auth/password/forgot`. A resposta é a mesma exista o e-mail ou não (1.10 CA1); só a
   * conta real recebe o link.
   */
  async request(email: string, ip: string): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.passwordForgotPerIp, ip);
    await this.rateLimiter.consume(RATE_LIMITS.passwordForgotPerEmail, rateLimitSubject(email));
    const account = await this.credentials.findActiveByEmail(email);
    if (account === undefined) {
      return;
    }
    const now = this.clock.now();
    const token = generateOpaqueToken();
    await this.tokens.db.transaction(async (tx) => {
      await this.tokens.invalidateUnused(tx, account.id, 'reset_password', now);
      await this.tokens.insert(tx, {
        userId: account.id,
        purpose: 'reset_password',
        email: account.email,
        tokenHash: hashOpaqueToken(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.ttlMs),
      });
    });
    const link = emailLink(this.linkBaseUrl, EMAIL_PATHS.resetPassword, token);
    void this.sender
      .send(passwordResetEmail(account.email, account.name, link))
      .catch((error: unknown) => {
        this.logger.error(`Falha ao enviar e-mail de redefinição: ${describeError(error)}`);
      });
  }

  /**
   * `POST /auth/password/reset`: link de uso único e dentro da validade; troca a senha, confirma o
   * e-mail (quem abriu o link é dono dele) e revoga todas as sessões (1.10 CA2).
   */
  async reset(token: string, password: string): Promise<void> {
    if (isWeakPassword(password)) {
      throw new DomainError(ErrorCode.WEAK_PASSWORD, 400, 'Senha fraca');
    }
    const passwordHash = await this.hasher.hash(password);
    const now = this.clock.now();
    const done = await this.tokens.db.transaction(async (tx) => {
      const row = await this.tokens.findUsableForUpdate(
        tx,
        hashOpaqueToken(token),
        'reset_password',
        now,
      );
      if (row === undefined) {
        return false;
      }
      await this.tokens.markUsed(tx, row.id, now);
      await this.tokens.invalidateUnused(tx, row.userId, 'reset_password', now);
      await this.credentials.updatePassword(tx, row.userId, passwordHash, now);
      await this.sessions.revokeAll(row.userId, tx);
      return true;
    });
    if (!done) {
      throw new DomainError(
        ErrorCode.INVALID_TOKEN,
        400,
        'Link de redefinição inválido ou vencido',
      );
    }
  }
}
