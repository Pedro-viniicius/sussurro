import { Injectable, Logger } from '@nestjs/common';
import { users } from '@sussurro/db';
import {
  ErrorCode,
  type NearbyPerson,
  type ProximityResolveResult,
  type ProximityToken,
} from '@sussurro/shared';

import {
  generateProximityToken,
  hashProximityToken,
  PROXIMITY_LIMITS,
  PROXIMITY_LOCK_MS,
} from './proximity-token.js';
import { type NearbyRow, ProximityRepository } from './proximity.repository.js';
import { ProximityStore, type ProximityTtls } from './proximity.store.js';
import { withTimeout } from '../../common/async/with-timeout.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { DomainError } from '../../common/errors/domain-error.js';
import type { RateLimitRule } from '../../common/rate-limit/rate-limiter.service.js';
import { AppConfig } from '../../config/config.module.js';
import { MediaService } from '../media/media.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';

/** Tempo máximo esperando o Redis antes de responder 503 (fail-closed, R11). */
export const PROXIMITY_STORE_TIMEOUT_MS = 500;

export function proximityUnavailable(): DomainError {
  return new DomainError(
    ErrorCode.PROXIMITY_UNAVAILABLE,
    503,
    'Conectar está indisponível agora. Tente de novo em instantes.',
  );
}

export function screenClosed(): DomainError {
  return new DomainError(
    ErrorCode.PROXIMITY_SCREEN_CLOSED,
    409,
    'Abra a tela Conectar para continuar.',
  );
}

/**
 * Mensagem única para token inexistente, vencido, de outra pessoa, de conta excluída, com bloqueio
 * ou dentro do intervalo depois de uma recusa (PROX-17, X.2 CA2): o corpo é sempre o mesmo.
 */
export function proximityTokenInvalid(): DomainError {
  return new DomainError(
    ErrorCode.PROXIMITY_TOKEN_INVALID,
    400,
    'Não foi possível enviar o pedido agora. Tente mais tarde.',
  );
}

function tooManyAttempts(retryAfterMs: number): DomainError {
  return new DomainError(ErrorCode.RATE_LIMITED, 429, 'Muitas tentativas', {
    retryAfterS: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  });
}

/** O token de uma emissão (ADR 0013 §1): o mesmo no QR e no NFC. */
export interface IssuedToken {
  token: string;
  issuedAt: Date;
}

/** O token mais recente de cada dono entre os enviados, com a ordem do primeiro token dele. */
type NewestByOwner = Map<string, { token: string; issuedAt: number; order: number }>;

/**
 * Tokens de proximidade (ADR 0003, história 4.2; ADR 0013) e o `resolve` do código lido (QR ou
 * NFC). Também valida, para o módulo `connections`, os tokens de quem pede e de quem aceita, a tela
 * aberta e os limites de abuso. Tudo que toca o Redis falha **fechado**: sem Redis, 503
 * `PROXIMITY_UNAVAILABLE`, e login, feed e perfil seguem normais (PROX-21).
 *
 * Privacidade: nenhuma rota recebe dado do aparelho; o Redis guarda só o hash do token, por até
 * 120 s, sem ir para o Postgres nem para o log.
 */
@Injectable()
export class ProximityService {
  private readonly logger = new Logger(ProximityService.name);
  private readonly ttls: ProximityTtls;
  /** O app renova a cada 20 s com o TTL padrão de 30 s (2/3 da validade). */
  private readonly renewInS: number;

  constructor(
    private readonly store: ProximityStore,
    private readonly repository: ProximityRepository,
    private readonly policy: AccessPolicyService,
    private readonly media: MediaService,
    private readonly clock: Clock,
    config: AppConfig,
  ) {
    this.ttls = {
      validMs: config.env.PROX_TOKEN_TTL_S * 1000,
      recentMs: config.env.PROX_RECENT_TTL_S * 1000,
      screenMs: config.env.PROX_SCREEN_TTL_S * 1000,
    };
    this.renewInS = Math.max(1, Math.round((config.env.PROX_TOKEN_TTL_S * 2) / 3));
  }

  /** Uma operação no store com prazo: erro ou demora viram 503 (fail-closed). */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(operation(), PROXIMITY_STORE_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(`Proximidade indisponível (fechada): ${describeError(error)}`);
      throw proximityUnavailable();
    }
  }

  /** Bloqueio de 15 min depois de 20 falhas de token (PROX-20): 429 com `Retry-After`. */
  async assertNotLocked(viewer: AuthContext): Promise<void> {
    const remaining = await this.guarded(() => this.store.lockRemainingMs(viewer.userId));
    if (remaining > 0) {
      throw tooManyAttempts(remaining);
    }
  }

  /** Conta uma tentativa no limite (por conta) e lança 429 acima dele. */
  async consume(rule: RateLimitRule, viewer: AuthContext): Promise<void> {
    const hit = await this.guarded(() =>
      this.store.hit(`rl:${rule.name}:${viewer.userId}`, rule.windowMs),
    );
    if (hit.count > rule.limit) {
      throw tooManyAttempts(hit.resetInMs);
    }
  }

  /** `prox:u` de quem chama: a tela Conectar está aberta (PROX-04, PROX-10). */
  async assertScreenOpen(viewer: AuthContext): Promise<void> {
    if (!(await this.guarded(() => this.store.isScreenOpen(viewer.userId)))) {
      throw screenClosed();
    }
  }

  /** Dono do token se ele ainda é **válido** (até 30 s): o que o pedido exige (ADR 0013 §2). */
  async ownerOfValidToken(token: string): Promise<string | null> {
    const [record] = await this.guarded(() => this.store.findValid([hashProximityToken(token)]));
    return record?.userId ?? null;
  }

  /**
   * Dono do token se ele é válido **ou recente** (até 120 s): o que o aceite exige (D7, PROX-03),
   * nos dois métodos.
   */
  async ownerOfRecentToken(token: string): Promise<string | null> {
    const record = await this.guarded(() => this.store.findRecent(hashProximityToken(token)));
    return record?.userId ?? null;
  }

  /**
   * Conta uma falha de token (pedido ou aceite recusado). Na 20ª em 10 min, a proximidade da conta
   * fica bloqueada por 15 min, também no QR (PROX-20, 4.7 CA7).
   */
  async recordFailure(viewer: AuthContext): Promise<void> {
    const rule = PROXIMITY_LIMITS.failures;
    const hit = await this.guarded(() =>
      this.store.hit(`rl:${rule.name}:${viewer.userId}`, rule.windowMs),
    );
    if (hit.count >= rule.limit) {
      await this.guarded(() => this.store.lock(viewer.userId, PROXIMITY_LOCK_MS));
    }
  }

  /**
   * Emite e grava o token da conta (ADR 0013 §1: um só, o mesmo no QR e no NFC). O servidor guarda
   * só o hash.
   */
  private async issueFor(userId: string): Promise<IssuedToken> {
    const issuedAt = this.clock.now();
    const token = generateProximityToken();
    await this.guarded(() =>
      this.store.issue(
        hashProximityToken(token),
        { userId, issuedAt: issuedAt.getTime() },
        this.ttls,
      ),
    );
    return { token, issuedAt };
  }

  /**
   * `POST /proximity/tokens` (4.2): o token novo, válido por 30 s, e a tela marcada como aberta. O
   * app pede outro a cada `renewInS` (20 s) enquanto a tela está em primeiro plano. O limite de 6
   * por minuto conta a emissão.
   */
  async issueToken(viewer: AuthContext): Promise<ProximityToken> {
    await this.assertNotLocked(viewer);
    await this.consume(PROXIMITY_LIMITS.tokens, viewer);
    const { token, issuedAt } = await this.issueFor(viewer.userId);
    return {
      token,
      expiresAt: new Date(issuedAt.getTime() + this.ttls.validMs).toISOString(),
      renewInS: this.renewInS,
    };
  }

  /**
   * Token para uma persona do seed (só a rota de simulação em desenvolvimento, 4.11): sem limite,
   * mas com a mesma gravação e a mesma validade.
   */
  issueForSimulation(personaId: string): Promise<IssuedToken> {
    return this.issueFor(personaId);
  }

  /**
   * Os tokens **válidos** (até 30 s), agrupados por dono: fica o mais recente de cada pessoa, na
   * ordem do primeiro token dela no pedido (PROX-25). Ficam de fora, sem aviso, os repetidos, os
   * inexistentes ou vencidos e os do próprio chamador.
   */
  private async newestByOwner(
    viewer: AuthContext,
    tokens: readonly string[],
  ): Promise<NewestByOwner> {
    const unique = [...new Set(tokens)];
    const records = await this.guarded(() =>
      this.store.findValid(unique.map((token) => hashProximityToken(token))),
    );
    const newest: NewestByOwner = new Map();
    unique.forEach((token, order) => {
      const record = records[order];
      // Sem registro (inexistente ou vencido) ou do próprio chamador: ignorado.
      if (record === null || record === undefined || record.userId === viewer.userId) {
        return;
      }
      const current = newest.get(record.userId);
      if (current === undefined) {
        newest.set(record.userId, { token, issuedAt: record.issuedAt, order });
      } else if (record.issuedAt > current.issuedAt) {
        newest.set(record.userId, { token, issuedAt: record.issuedAt, order: current.order });
      }
    });
    return newest;
  }

  /** O cartão (@, nome, foto, `alreadyConnected` e o token enviado) de cada conta, na ordem. */
  private async cards(rows: readonly NearbyRow[], newest: NewestByOwner): Promise<NearbyPerson[]> {
    const people = await Promise.all(
      rows.map(async (row): Promise<NearbyPerson & { order: number }> => {
        const seen = newest.get(row.id);
        return {
          token: seen?.token ?? '',
          handle: row.handle,
          name: row.name,
          avatarUrl: await this.media.signUrl(row.avatarKey),
          alreadyConnected: row.connected,
          order: seen?.order ?? 0,
        };
      }),
    );
    return people
      .sort((first, second) => first.order - second.order)
      .map(({ order: _order, ...person }) => person);
  }

  /**
   * `POST /proximity/resolve` (4.4; ADR 0013): cada token **válido** lido (QR ou NFC) vira o cartão
   * da pessoa que mostrou o código. Ficam de fora, sem aviso e com a mesma resposta de token
   * inexistente (PROX-05), os tokens inválidos ou vencidos, os do próprio chamador, os de conta excluída ou de criador e os de quem tem bloqueio com ele em
   * qualquer sentido. Exige a tela aberta de quem chama (PROX-04).
   *
   * Tokens que não resolvem **não** contam como falha. O limite de 30 chamadas por minuto, com até
   * 20 tokens cada, segura a força bruta.
   */
  async resolve(viewer: AuthContext, tokens: readonly string[]): Promise<ProximityResolveResult> {
    await this.assertNotLocked(viewer);
    await this.consume(PROXIMITY_LIMITS.resolve, viewer);
    await this.assertScreenOpen(viewer);

    const newest = await this.newestByOwner(viewer, tokens);
    const rows = await this.repository.findNearby(
      viewer.userId,
      [...newest.keys()],
      this.policy.hideBlockedFor(viewer, users.id),
    );
    return { items: await this.cards(rows, newest) };
  }

  /**
   * Logout e exclusão de conta (PROX-27): os tokens da conta deixam de resolver e de valer em
   * pedidos e aceites. Sem Redis, não impede o logout (a autenticação não depende dele, R11): os
   * tokens vencem sozinhos em até 120 s, e a exclusão já some do banco na hora.
   */
  async revokeQuietly(userId: string): Promise<void> {
    try {
      await withTimeout(this.store.revokeUser(userId), PROXIMITY_STORE_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(`Tokens de proximidade não revogados agora: ${describeError(error)}`);
    }
  }
}
