import { Injectable } from '@nestjs/common';
import { findPgError, PgErrorCode } from '@sussurro/db';
import {
  type AuthSession,
  ErrorCode,
  isReservedHandle,
  isWeakPassword,
  type LoginRequest,
  type RegisterRequest,
} from '@sussurro/shared';

import { CredentialsRepository } from './credentials.repository.js';
import { EmailTokensRepository } from './email-tokens.repository.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionsService } from './sessions.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  RATE_LIMITS,
  RateLimiterService,
  rateLimitSubject,
} from '../../common/rate-limit/rate-limiter.service.js';
import { CommentsService } from '../comments/comments.service.js';
import { ConnectionsService } from '../connections/connections.service.js';
import { LikesService } from '../likes/likes.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { UsersService } from '../users/users.service.js';

const emailTaken = () => new DomainError(ErrorCode.EMAIL_TAKEN, 409, 'E-mail em uso');
const handleTaken = () => new DomainError(ErrorCode.HANDLE_TAKEN, 409, '@ em uso');

/** Cadastro, login, logout e exclusão de conta (ADR 0007, histórias 1.1 a 1.4 e 1.7). */
@Injectable()
export class AuthService {
  constructor(
    private readonly credentials: CredentialsRepository,
    private readonly emailTokens: EmailTokensRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionsService,
    private readonly emailVerification: EmailVerificationService,
    private readonly users: UsersService,
    private readonly likes: LikesService,
    private readonly comments: CommentsService,
    private readonly connections: ConnectionsService,
    private readonly notifications: NotificationsService,
    private readonly rateLimiter: RateLimiterService,
    private readonly clock: Clock,
  ) {}

  /**
   * `POST /auth/register` (história 1.1). O rate limit conta tentativas, não só sucessos: o 409
   * "@ em uso" é um oráculo aceito (A-05) desde que limitado a 5 por hora por IP.
   */
  async register(input: RegisterRequest, ip: string): Promise<AuthSession> {
    await this.rateLimiter.consume(RATE_LIMITS.registerPerIp, ip);
    if (isWeakPassword(input.password)) {
      throw new DomainError(ErrorCode.WEAK_PASSWORD, 400, 'Senha fraca');
    }
    if (isReservedHandle(input.handle)) {
      throw new DomainError(ErrorCode.HANDLE_RESERVED, 400, '@ reservado');
    }
    if (await this.credentials.isEmailInUse(input.email)) {
      throw emailTaken();
    }
    if (await this.credentials.isHandleUnavailable(input.handle)) {
      throw handleTaken();
    }

    const passwordHash = await this.hasher.hash(input.password);
    const now = this.clock.now();
    let created;
    try {
      created = await this.credentials.db.transaction(async (tx) => {
        const account = await this.credentials.insertAccount(tx, {
          email: input.email,
          passwordHash,
          handle: input.handle,
          name: input.name,
          accountType: input.accountType,
          now,
        });
        const tokens = await this.sessions.start(account, input.deviceLabel, tx);
        return { account, tokens };
      });
    } catch (error) {
      // Corrida com outro cadastro igual entre a checagem e o INSERT.
      const pgError = findPgError(error);
      if (pgError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        throw pgError.constraint === 'users_handle_key' ? handleTaken() : emailTaken();
      }
      throw error;
    }

    await this.emailVerification.issueSafely(created.account);
    return { user: await this.users.getMe(created.account.id), tokens: created.tokens };
  }

  /**
   * `POST /auth/login` (história 1.2, D14: só e-mail). Senha errada e e-mail inexistente dão o
   * mesmo 401, com o mesmo custo de argon2 (AUTH-06).
   */
  async login(input: LoginRequest, ip: string): Promise<AuthSession> {
    await this.rateLimiter.consume(RATE_LIMITS.loginPerIp, ip);
    await this.rateLimiter.consume(
      RATE_LIMITS.loginPerIpAndEmail,
      `${ip}|${rateLimitSubject(input.email)}`,
    );
    const account = await this.credentials.findActiveByEmail(input.email);
    const valid =
      account === undefined
        ? await this.hasher.verifyAgainstDummy(input.password)
        : await this.hasher.verify(account.passwordHash, input.password);
    if (account === undefined || !valid) {
      throw new DomainError(ErrorCode.INVALID_CREDENTIALS, 401, 'E-mail ou senha incorretos.');
    }
    const tokens = await this.sessions.start(account, input.deviceLabel);
    return { user: await this.users.getMe(account.id), tokens };
  }

  refresh(refreshToken: string) {
    return this.sessions.rotate(refreshToken);
  }

  /**
   * Sai deste aparelho: revoga a família do access token (AUTH-12). Fase 4 (PROX-27): os tokens de
   * proximidade da conta deixam de valer e os pedidos de conexão pendentes dela são cancelados.
   */
  async logout(auth: AuthContext): Promise<void> {
    await this.sessions.revokeFamily(auth.userId, auth.familyId);
    await this.connections.endPresence(auth.userId);
  }

  /** Sai de todos os aparelhos (AUTH-12), com o mesmo efeito na proximidade do `logout`. */
  async logoutAll(auth: AuthContext): Promise<void> {
    await this.sessions.revokeAll(auth.userId);
    await this.connections.endPresence(auth.userId);
  }

  /**
   * `DELETE /me` com a senha (A-15). A conta some na hora (`deleted_at`), o @ é aposentado (A-14),
   * as sessões e os links de e-mail são revogados. Curtidas e comentários da pessoa somem na mesma
   * transação, com os contadores dos posts ajustados (A-13, CONTA-03); os posts dela saem do feed
   * e do perfil pelo filtro de `deleted_at` (A-11). O hard delete roda no worker (CONTA-05). Fase 4
   * (PROX-27): os pedidos de conexão pendentes são cancelados na mesma transação e os tokens de
   * proximidade, revogados logo depois. Fase 6: push tokens e notificações também, na transação.
   */
  async deleteAccount(auth: AuthContext, password: string): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.accountDeletionPerUser, auth.userId);
    const account = await this.credentials.findActiveById(auth.userId);
    if (account === undefined) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 401, 'Conta inexistente');
    }
    if (!(await this.hasher.verify(account.passwordHash, password))) {
      throw new DomainError(ErrorCode.INVALID_CREDENTIALS, 401, 'Senha incorreta');
    }
    const now = this.clock.now();
    await this.credentials.db.transaction(async (tx) => {
      await this.credentials.softDelete(tx, account.id, now);
      await this.sessions.revokeAll(account.id, tx);
      await this.emailTokens.invalidateAllForUser(tx, account.id, now);
      await this.likes.removeAllByUser(tx, account.id);
      await this.comments.removeAllByUser(tx, account.id, now);
      await this.connections.cancelPendingRequests(tx, account.id, now);
      // Fase 6: as notificações da conta e as em que ela agiu saem na hora (os push tokens já
      // saíram com o `revokeAll`).
      await this.notifications.removeAllInvolving(tx, account.id);
    });
    await this.connections.revokeProximity(account.id);
  }
}
