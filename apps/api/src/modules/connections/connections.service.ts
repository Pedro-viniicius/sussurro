import { Injectable } from '@nestjs/common';
import { type ConnectionRequestRow, type DbExecutor, users } from '@sussurro/db';
import {
  type ConnectionMethod,
  type ConnectionRequest,
  type CreateConnectionRequest,
  ErrorCode,
  type IncomingConnectionRequests,
  isValidHandleFormat,
  normalizeHandle,
  type PushJobMessage,
  type SimulatedConnectionRequest,
} from '@sussurro/shared';

import { toConnectionRequestView } from './connection-request.view.js';
import { ConnectionsRepository, type RequestParty } from './connections.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { lockAccountPair } from '../../common/db/pair-lock.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { AppConfig } from '../../config/config.module.js';
import { MediaService } from '../media/media.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AccessPolicyService, type ProfileTarget } from '../policies/access-policy.service.js';
import { PROXIMITY_LIMITS } from '../proximity/proximity-token.js';
import { ProximityService, proximityTokenInvalid } from '../proximity/proximity.service.js';
import type { ProfileRow } from '../users/profile.mapper.js';
import { UsersService } from '../users/users.service.js';

/** Pedidos pendentes devolvidos por `incoming` (as folhas aparecem uma por vez). */
const INCOMING_LIMIT = 20;

/** Personas do seed que a rota de simulação aceita (4.11, só em desenvolvimento). */
export const SIMULATION_PERSONAS = ['lucasf', 'tomas'] as const;

/** Pedido que não existe para quem chama: terceiro, conta excluída ou bloqueio (PROX-12). */
function requestNotFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, 404, 'Pedido não encontrado');
}

/** @ que não é conexão de quem chama, inexistente ou de conta excluída: o mesmo 404 (4.9 CA3). */
function connectionNotFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, 404, 'Conexão não encontrada');
}

function alreadyConnected(): DomainError {
  return new DomainError(ErrorCode.ALREADY_CONNECTED, 409, 'Vocês já estão conectados.');
}

function requestExpired(): DomainError {
  return new DomainError(ErrorCode.REQUEST_EXPIRED, 410, 'O pedido expirou.');
}

function cannotConnectSelf(): DomainError {
  return new DomainError(ErrorCode.CANNOT_CONNECT_SELF, 400, 'Este código é da sua própria conta.');
}

/** Resultado da abertura de um pedido (dentro da transação do par). */
type OpenOutcome =
  | { kind: 'denied' }
  | { kind: 'connected' }
  | { kind: 'created' | 'existing'; request: ConnectionRequestRow }
  | { kind: 'accepted'; request: ConnectionRequestRow; jobs: PushJobMessage[] };

/** Resultado do aceite (dentro da transação do par). */
type AcceptOutcome =
  | { kind: 'accepted'; request: ConnectionRequestRow; jobs: PushJobMessage[] }
  | { kind: 'gone' }
  | { kind: 'expired' };

/** Resposta de `POST /connections/requests`: o pedido e se ele acabou de ser criado (201). */
export interface CreatedRequest {
  created: boolean;
  request: ConnectionRequest;
}

/** Conta pessoal vista pela política (o remetente da simulação não tem `AuthContext` real). */
function asViewer(account: { id: string }): AuthContext {
  return { userId: account.id, accountType: 'personal', familyId: '', emailVerified: true };
}

/**
 * Pedidos de conexão presencial e desfazer conexão (ADR 0003; histórias 4.5, 4.6, 4.9 e 4.11). A
 * prova de presença (tokens cruzados, tela aberta, limites) vem do `ProximityService`; quem pode
 * se conectar com quem (tipo de conta e bloqueio) vem do `AccessPolicyService`. Toda escrita do
 * par pega a trava do par (`lockAccountPair`), a mesma de seguir e bloquear: um pedido concorrente
 * nunca sobrevive a um bloqueio, e A→B ∥ B→A vira uma conexão só (PROX-13).
 */
@Injectable()
export class ConnectionsService {
  private readonly requestTtlMs: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly connections: ConnectionsRepository,
    private readonly proximity: ProximityService,
    private readonly users: UsersService,
    private readonly policy: AccessPolicyService,
    private readonly media: MediaService,
    private readonly notifications: NotificationsService,
    private readonly clock: Clock,
    config: AppConfig,
  ) {
    this.requestTtlMs = config.env.CONNECTION_REQUEST_TTL_S * 1000;
    this.cooldownMs = config.env.CONNECTION_DECLINE_COOLDOWN_S * 1000;
  }

  private async view(
    request: ConnectionRequestRow,
    viewerId: string,
    other: RequestParty | ProfileRow,
    now: Date,
  ): Promise<ConnectionRequest> {
    return toConnectionRequestView(
      request,
      viewerId,
      {
        handle: other.handle,
        name: other.name,
        avatarUrl: await this.media.signUrl(other.avatarKey),
      },
      now,
    );
  }

  /**
   * Abre (ou encontra) o pedido `from → to`, na transação do par:
   * 1. a política decide tipo de conta e bloqueio (`denied`) e se já são conexão (`connected`);
   * 2. os pendentes vencidos do par viram `expired`;
   * 3. recusa de `to` nos últimos 60 min → `denied` (a mesma resposta genérica, PROX-17);
   * 4. se `to` já pediu para `from` (B→A pendente), os dois já observaram o token um do outro: a
   *    conexão nasce na hora, com o método do pedido de B (PROX-13, PROX-22);
   * 5. se `from` já pediu para `to`, devolve o mesmo pedido (PROX-16); senão, cria um novo.
   */
  private openRequest(
    from: { id: string },
    to: ProfileTarget,
    method: ConnectionMethod,
    now: Date,
  ): Promise<OpenOutcome> {
    return this.connections.db.transaction(async (tx): Promise<OpenOutcome> => {
      await lockAccountPair(tx, from.id, to.id);
      const state = await this.policy.connectionRequestState(asViewer(from), to, tx);
      if (state !== 'allowed') {
        return { kind: state };
      }
      await this.connections.expireStaleBetween(tx, from.id, to.id, now);
      const since = new Date(now.getTime() - this.cooldownMs);
      if (await this.connections.declinedSince(tx, from.id, to.id, since)) {
        return { kind: 'denied' };
      }
      const reverse = await this.connections.findPending(tx, to.id, from.id);
      if (reverse !== undefined) {
        const added = await this.connections.insertConnection(tx, from.id, to.id, {
          method: reverse.method,
          requestId: reverse.id,
          now,
        });
        // PROX-29: a notificação para os dois, na mesma transação; o push vai para `to`, que pediu
        // primeiro (quem chama agora está com a tela aberta).
        const jobs = added
          ? await this.notifications.recordConnection(tx, {
              first: from.id,
              second: to.id,
              pushTo: to.id,
              now,
            })
          : [];
        const accepted = await this.connections.close(tx, reverse.id, 'accepted', now);
        return { kind: 'accepted', request: accepted ?? reverse, jobs };
      }
      const existing = await this.connections.findPending(tx, from.id, to.id);
      if (existing !== undefined) {
        return { kind: 'existing', request: existing };
      }
      const created = await this.connections.insertPending(tx, {
        fromId: from.id,
        toId: to.id,
        method,
        now,
        expiresAt: new Date(now.getTime() + this.requestTtlMs),
      });
      return { kind: 'created', request: created };
    });
  }

  /**
   * `POST /connections/requests` (4.5): A pede conexão com o token de B que observou. Exige a tela
   * aberta de A e o token **válido** de B (até 30 s). Token inexistente, vencido, de conta excluída,
   * com bloqueio ou dentro do intervalo de recusa → a mesma mensagem genérica, contada como falha.
   */
  async createRequest(
    viewer: AuthContext,
    input: CreateConnectionRequest,
  ): Promise<CreatedRequest> {
    await this.proximity.assertNotLocked(viewer);
    await this.proximity.consume(PROXIMITY_LIMITS.requestsPerMinute, viewer);
    await this.proximity.consume(PROXIMITY_LIMITS.requestsPerDay, viewer);
    await this.proximity.assertScreenOpen(viewer);

    const ownerId = await this.proximity.ownerOfValidToken(input.targetToken);
    if (ownerId === viewer.userId) {
      throw cannotConnectSelf();
    }
    const target = ownerId === null ? undefined : await this.users.findActiveAccountById(ownerId);
    const now = this.clock.now();
    const outcome =
      target === undefined
        ? ({ kind: 'denied' } as const)
        : await this.openRequest({ id: viewer.userId }, target, input.method, now);

    if (outcome.kind === 'denied' || target === undefined) {
      await this.proximity.recordFailure(viewer);
      throw proximityTokenInvalid();
    }
    if (outcome.kind === 'connected') {
      throw alreadyConnected();
    }
    await this.afterOpen(outcome);
    return {
      created: outcome.kind === 'created',
      request: await this.view(outcome.request, viewer.userId, target, now),
    };
  }

  /**
   * Depois do commit (Fase 6): pedido novo → push para quem recebeu (6.6, abre o Conectar);
   * conexão criada pelo pedido cruzado → o push da notificação. Best-effort (só log se a fila falhar).
   */
  private async afterOpen(outcome: OpenOutcome): Promise<void> {
    if (outcome.kind === 'created') {
      await this.notifications.notifyConnectionRequest(outcome.request.id);
    } else if (outcome.kind === 'accepted') {
      await this.notifications.dispatch(outcome.jobs);
    }
  }

  /** `GET /connections/requests/incoming` (polling de 2 s de B): só os pedidos para quem chama. */
  async incoming(viewer: AuthContext): Promise<IncomingConnectionRequests> {
    const now = this.clock.now();
    const rows = await this.connections.listIncoming(
      viewer.userId,
      now,
      this.policy.hideBlockedFor(viewer, users.id),
      INCOMING_LIMIT,
    );
    return {
      items: await Promise.all(
        rows.map((row) => this.view(row.request, viewer.userId, row.other, now)),
      ),
    };
  }

  private async findForParty(viewer: AuthContext, id: string) {
    const found = await this.connections.findForParty(
      id,
      viewer.userId,
      this.policy.hideBlockedFor(viewer, users.id),
    );
    if (found === undefined) {
      throw requestNotFound();
    }
    return found;
  }

  /** `GET /connections/requests/:id` (polling de 2 s de A): só as duas pessoas (PROX-12). */
  async get(viewer: AuthContext, id: string): Promise<ConnectionRequest> {
    const found = await this.findForParty(viewer, id);
    return this.view(found.request, viewer.userId, found.other, this.clock.now());
  }

  /**
   * `POST /connections/requests/:id/accept` (4.6): B confirma com o token de A que observou
   * (válido ou recente, até 120 s; no QR cruzado, o lido do QR de A, D7). Exige a tela aberta de B.
   * Token ausente → 400 pelo schema; token de outra pessoa ou vencido → a mensagem genérica, e o
   * pedido continua pendente (PROX-09). Aceitar de novo devolve o mesmo resultado (PROX-11c, 14).
   */
  async accept(viewer: AuthContext, id: string, observedToken: string): Promise<ConnectionRequest> {
    await this.proximity.assertNotLocked(viewer);
    await this.proximity.consume(PROXIMITY_LIMITS.accepts, viewer);
    const { request, other } = await this.findForParty(viewer, id);
    if (request.toId !== viewer.userId) {
      throw requestNotFound();
    }
    if (request.status === 'accepted') {
      return this.view(request, viewer.userId, other, this.clock.now());
    }
    if (request.status === 'declined' || request.status === 'cancelled') {
      throw requestNotFound();
    }
    await this.proximity.assertScreenOpen(viewer);
    const now = this.clock.now();
    if (request.status === 'expired' || request.expiresAt.getTime() <= now.getTime()) {
      await this.expire(request, now);
      throw requestExpired();
    }
    if ((await this.proximity.ownerOfRecentToken(observedToken)) !== request.fromId) {
      await this.proximity.recordFailure(viewer);
      throw proximityTokenInvalid();
    }

    const outcome = await this.connections.db.transaction(async (tx): Promise<AcceptOutcome> => {
      await lockAccountPair(tx, request.fromId, request.toId);
      const row = await this.connections.lockRequest(tx, request.id);
      if (row?.status === 'accepted') {
        return { kind: 'accepted', request: row, jobs: [] };
      }
      if (row?.status === 'expired') {
        // O job do worker marcou o vencido entre a leitura e a trava.
        return { kind: 'expired' };
      }
      if (row?.status !== 'pending') {
        return { kind: 'gone' };
      }
      if (row.expiresAt.getTime() <= now.getTime()) {
        await this.connections.close(tx, row.id, 'expired', now);
        return { kind: 'expired' };
      }
      const from: ProfileTarget = { id: row.fromId, accountType: 'personal' };
      if ((await this.policy.connectionRequestState(viewer, from, tx)) === 'denied') {
        return { kind: 'gone' };
      }
      const added = await this.connections.insertConnection(tx, row.fromId, row.toId, {
        method: row.method,
        requestId: row.id,
        now,
      });
      // PROX-29: a notificação para os dois, na mesma transação; o push vai para quem pediu.
      const jobs = added
        ? await this.notifications.recordConnection(tx, {
            first: row.fromId,
            second: row.toId,
            pushTo: row.fromId,
            now,
          })
        : [];
      const accepted = await this.connections.close(tx, row.id, 'accepted', now);
      return { kind: 'accepted', request: accepted ?? row, jobs };
    });

    if (outcome.kind === 'gone') {
      throw requestNotFound();
    }
    if (outcome.kind === 'expired') {
      throw requestExpired();
    }
    await this.notifications.dispatch(outcome.jobs);
    return this.view(outcome.request, viewer.userId, other, now);
  }

  private async expire(request: ConnectionRequestRow, now: Date): Promise<void> {
    if (request.status === 'pending') {
      await this.connections.db.transaction(async (tx) => {
        await lockAccountPair(tx, request.fromId, request.toId);
        await this.connections.close(tx, request.id, 'expired', now);
      });
    }
  }

  /**
   * Fecha o pendente pelo lado de quem chama: B recusa (`declined`, 4.6) ou A cancela
   * (`cancelled`, 4.5 CA9). Pedido já fechado: nada muda e a resposta mostra o estado atual. A
   * recusa abre o intervalo de 1 h para A (pela data da resposta, no próprio pedido).
   */
  private async close(
    viewer: AuthContext,
    id: string,
    side: 'from' | 'to',
    status: 'declined' | 'cancelled',
  ): Promise<ConnectionRequest> {
    const { request, other } = await this.findForParty(viewer, id);
    if ((side === 'to' ? request.toId : request.fromId) !== viewer.userId) {
      throw requestNotFound();
    }
    const now = this.clock.now();
    const closed = await this.connections.db.transaction(async (tx) => {
      await lockAccountPair(tx, request.fromId, request.toId);
      const row = await this.connections.lockRequest(tx, request.id);
      if (row?.status !== 'pending') {
        return row ?? request;
      }
      const next = row.expiresAt.getTime() <= now.getTime() ? 'expired' : status;
      return (await this.connections.close(tx, row.id, next, now)) ?? row;
    });
    return this.view(closed, viewer.userId, other, now);
  }

  /** `POST /connections/requests/:id/decline`: só quem recebeu (PROX-12, PROX-17). */
  decline(viewer: AuthContext, id: string): Promise<ConnectionRequest> {
    return this.close(viewer, id, 'to', 'declined');
  }

  /** `DELETE /connections/requests/:id`: só quem pediu (PROX-18). */
  cancel(viewer: AuthContext, id: string): Promise<ConnectionRequest> {
    return this.close(viewer, id, 'from', 'cancelled');
  }

  /**
   * `DELETE /connections/:handle` (4.9, D8): desfaz a conexão na hora (feed, perfil e posts deixam
   * de aparecer na próxima requisição; contadores por `COUNT(*)`). A outra pessoa não é avisada.
   * @ que não é conexão, inexistente ou de conta excluída → o mesmo 404.
   */
  async disconnect(viewer: AuthContext, rawHandle: string): Promise<void> {
    const other = await this.users.findActiveAccount(rawHandle);
    if (other === undefined || other.id === viewer.userId) {
      throw connectionNotFound();
    }
    const removed = await this.connections.db.transaction(async (tx) => {
      await lockAccountPair(tx, viewer.userId, other.id);
      const deleted = await this.connections.deleteConnection(tx, viewer.userId, other.id);
      if (deleted) {
        // Fase 6: "Vocês estão conectados" sai das notificações dos dois.
        await this.notifications.removeConnection(tx, viewer.userId, other.id);
      }
      return deleted;
    });
    if (!removed) {
      throw connectionNotFound();
    }
  }

  /**
   * Logout (PROX-27): os pedidos pendentes da conta são cancelados (o aceite passa a dar 404) e os
   * tokens de proximidade deixam de valer. Sem Redis, o logout segue (os tokens vencem sozinhos).
   */
  async endPresence(userId: string): Promise<void> {
    await this.connections.cancelPendingInvolving(this.connections.db, userId, this.clock.now());
    await this.proximity.revokeQuietly(userId);
  }

  /** Exclusão de conta: cancela os pendentes na transação da exclusão (PROX-27). */
  cancelPendingRequests(executor: DbExecutor, userId: string, now: Date): Promise<void> {
    return this.connections.cancelPendingInvolving(executor, userId, now);
  }

  /** Exclusão de conta, depois do commit: os tokens deixam de valer. */
  revokeProximity(userId: string): Promise<void> {
    return this.proximity.revokeQuietly(userId);
  }

  /**
   * `POST /dev/simulate-request` (4.11, D15; a rota só existe com `NODE_ENV=development`): uma
   * persona do seed pede conexão para a conta logada, como se estivesse ao lado. Devolve também um
   * token válido da persona, que o app de desenvolvimento usa como `observedToken` no aceite.
   */
  async simulateIncoming(
    viewer: AuthContext,
    from: string | undefined,
    method: ConnectionMethod | undefined,
  ): Promise<SimulatedConnectionRequest> {
    const handle = normalizeHandle((from ?? SIMULATION_PERSONAS[0]).trim().replace(/^@/, ''));
    if (
      !isValidHandleFormat(handle) ||
      !(SIMULATION_PERSONAS as readonly string[]).includes(handle)
    ) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 400, 'Entrada inválida', [
        {
          path: 'from',
          message: `Use uma persona de simulação: ${SIMULATION_PERSONAS.join(', ')}.`,
        },
      ]);
    }
    const persona = await this.users.findActiveAccount(handle);
    if (persona?.accountType !== 'personal') {
      throw new DomainError(
        ErrorCode.NOT_FOUND,
        404,
        `Persona @${handle} ausente: rode pnpm db:seed.`,
      );
    }
    if (persona.id === viewer.userId) {
      throw cannotConnectSelf();
    }
    const observedToken = await this.proximity.issueForSimulation(persona.id);
    const now = this.clock.now();
    const viewerTarget: ProfileTarget = { id: viewer.userId, accountType: viewer.accountType };
    const outcome = await this.openRequest(persona, viewerTarget, method ?? 'ble', now);
    if (outcome.kind === 'connected') {
      throw alreadyConnected();
    }
    if (outcome.kind === 'denied') {
      throw new DomainError(
        ErrorCode.CONFLICT,
        409,
        `@${handle} não pode pedir conexão para esta conta agora (bloqueio ou recusa na última hora).`,
      );
    }
    // O mesmo push de um pedido de verdade (6.6), para testar a notificação no aparelho em dev.
    await this.afterOpen(outcome);
    return {
      request: await this.view(outcome.request, viewer.userId, persona, now),
      observedToken,
    };
  }
}
