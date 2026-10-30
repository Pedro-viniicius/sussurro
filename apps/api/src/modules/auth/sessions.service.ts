import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '@sussurro/db';
import { type AccountType, ErrorCode, type TokenPair } from '@sussurro/shared';

import { AccessTokenService } from './access-token.service.js';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.js';
import { decideRefresh } from './refresh-decision.js';
import { SessionsRepository } from './sessions.repository.js';
import { Clock } from '../../common/clock/clock.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { AppConfig } from '../../config/config.module.js';
import { PushTokensService } from '../notifications/push-tokens.service.js';

export interface SessionSubject {
  id: string;
  accountType: AccountType;
}

interface IssueOptions {
  familyId: string;
  deviceLabel: string | null;
  now: Date;
}

function invalidRefresh(): DomainError {
  return new DomainError(ErrorCode.UNAUTHORIZED, 401, 'Sessão inválida ou expirada');
}

/**
 * Sessões (ADR 0007): access JWT de 15 min + refresh opaco de 30 dias, rotacionado a cada uso
 * dentro de uma família (uma por login/aparelho).
 */
@Injectable()
export class SessionsService {
  private readonly refreshTtlMs: number;
  private readonly reuseGraceMs: number;

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly accessTokens: AccessTokenService,
    private readonly pushTokens: PushTokensService,
    private readonly clock: Clock,
    config: AppConfig,
  ) {
    this.refreshTtlMs = config.env.REFRESH_TOKEN_TTL_S * 1000;
    this.reuseGraceMs = config.env.REFRESH_REUSE_GRACE_S * 1000;
  }

  /** Nova família (login ou cadastro). */
  async start(
    subject: SessionSubject,
    deviceLabel: string | undefined,
    executor: DbExecutor = this.sessions.db,
  ): Promise<TokenPair> {
    const now = this.clock.now();
    const familyId = randomUUID();
    const issued = await this.issueRefresh(executor, subject.id, {
      familyId,
      deviceLabel: deviceLabel === undefined || deviceLabel === '' ? null : deviceLabel,
      now,
    });
    return this.pair(subject, familyId, issued.token, issued.expiresAt);
  }

  /**
   * `POST /auth/refresh` (AUTH-08, AUTH-09). A linha do token apresentado é travada na transação,
   * então duas rotações simultâneas do mesmo token são serializadas.
   */
  async rotate(refreshToken: string): Promise<TokenPair> {
    const now = this.clock.now();
    const tokenHash = hashOpaqueToken(refreshToken);

    const outcome = await this.sessions.db.transaction(async (tx) => {
      const current = await this.sessions.findByHashForUpdate(tx, tokenHash);
      const decision = decideRefresh(current, now, this.reuseGraceMs);
      if (current === undefined || decision === 'invalid') {
        return { kind: 'invalid' as const };
      }
      if (decision === 'reuse') {
        // Token antigo reapresentado depois da janela: provável roubo, revoga a família inteira
        // (e, desde a Fase 6, o push token daquela sessão).
        await this.sessions.revokeFamily(tx, current.userId, current.familyId, now);
        await this.pushTokens.removeFamily(tx, current.userId, current.familyId);
        return { kind: 'invalid' as const };
      }
      if (decision === 'retry') {
        // Retry de rede dentro da janela: o sucessor emitido antes é descartado.
        await this.sessions.revokeUnusedInFamily(tx, current.familyId, now);
      }
      const issued = await this.issueRefresh(tx, current.userId, {
        familyId: current.familyId,
        deviceLabel: current.deviceLabel,
        now,
      });
      if (decision === 'rotate') {
        await this.sessions.markUsed(tx, current.id, now, issued.id);
      } else {
        await this.sessions.setSuccessor(tx, current.id, issued.id);
      }
      return {
        kind: 'issued' as const,
        subject: { id: current.userId, accountType: current.accountType },
        familyId: current.familyId,
        issued,
      };
    });

    // O 401 sai depois do commit: a revogação da família por reuso precisa ficar gravada.
    if (outcome.kind === 'invalid') {
      throw invalidRefresh();
    }
    return this.pair(
      outcome.subject,
      outcome.familyId,
      outcome.issued.token,
      outcome.issued.expiresAt,
    );
  }

  /**
   * Logout deste aparelho (AUTH-12). O access token atual continua válido até vencer. (Fase 6) O
   * push token desta sessão sai na mesma transação: o aparelho para de receber push (6.4 CA2).
   */
  async revokeFamily(userId: string, familyId: string): Promise<void> {
    await this.sessions.db.transaction(async (tx) => {
      await this.sessions.revokeFamily(tx, userId, familyId, this.clock.now());
      await this.pushTokens.removeFamily(tx, userId, familyId);
    });
  }

  /**
   * "Sair de todos os dispositivos", troca de senha e exclusão de conta. (Fase 6) Todos os push
   * tokens da conta saem junto.
   */
  async revokeAll(userId: string, executor: DbExecutor = this.sessions.db): Promise<void> {
    await this.sessions.revokeAllForUser(executor, userId, this.clock.now());
    await this.pushTokens.removeAllForUser(executor, userId);
  }

  private async issueRefresh(executor: DbExecutor, userId: string, options: IssueOptions) {
    const token = generateOpaqueToken();
    const expiresAt = new Date(options.now.getTime() + this.refreshTtlMs);
    const id = await this.sessions.insert(executor, {
      userId,
      familyId: options.familyId,
      tokenHash: hashOpaqueToken(token),
      createdAt: options.now,
      expiresAt,
      deviceLabel: options.deviceLabel,
    });
    return { id, token, expiresAt };
  }

  private async pair(
    subject: SessionSubject,
    familyId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<TokenPair> {
    const access = await this.accessTokens.sign({
      sub: subject.id,
      acct: subject.accountType,
      fam: familyId,
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    };
  }
}
