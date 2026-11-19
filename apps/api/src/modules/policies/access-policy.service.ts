import { Injectable } from '@nestjs/common';
import type { DbExecutor, SQL } from '@sussurro/db';
import {
  type AccountType,
  CONNECTION_REQUEST_MODERATION_WINDOW_S,
  type PostStatus,
} from '@sussurro/shared';

import { NO_RELATIONSHIP, type Relationship, RelationsRepository } from './relations.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { ConnectionsRepository } from '../connections/connections.repository.js';

export type { Relationship } from './relations.repository.js';

export interface ProfileTarget {
  id: string;
  accountType: AccountType;
}

/** O que a política precisa saber de um post (e do autor) para decidir quem o vê. */
export interface PostTarget {
  authorId: string;
  authorType: AccountType;
  status: PostStatus;
  deletedAt: Date | null;
  /** `deleted_at` do autor: conta excluída some de tudo na hora (A-11, CONTA-02). */
  authorDeletedAt: Date | null;
}

/**
 * Perfil (arquitetura.md §7.3): a própria conta sempre; com bloqueio em qualquer sentido, nunca
 * (X.2: quem bloqueia e quem é bloqueado deixam de se ver); criador é visível a qualquer conta
 * autenticada; pessoal, só às conexões. Regra pura sobre a relação já consultada.
 */
export function isProfileVisible(
  viewer: AuthContext,
  target: ProfileTarget,
  relation: Relationship,
): boolean {
  if (target.id === viewer.userId) {
    return true;
  }
  if (relation.blocked) {
    return false;
  }
  if (target.accountType === 'creator') {
    return true;
  }
  return relation.connected;
}

/**
 * Post (arquitetura.md §7.2, MID-09): o autor vê o próprio em qualquer estado; os demais só veem
 * `published` de quem eles podem ver o perfil (inclui o bloqueio, X.2). Excluído (post ou conta)
 * não é visível para ninguém.
 */
export function isPostVisible(
  viewer: AuthContext,
  post: PostTarget,
  relation: Relationship,
): boolean {
  if (post.deletedAt !== null || post.authorDeletedAt !== null) {
    return false;
  }
  if (post.authorId === viewer.userId) {
    return true;
  }
  if (post.status !== 'published') {
    return false;
  }
  return isProfileVisible(viewer, { id: post.authorId, accountType: post.authorType }, relation);
}

/**
 * Seguir (ADR 0008, X.2): só conta pessoal segue, só criador é seguido, e o bloqueio em qualquer
 * sentido impede. Quem não pode seguir recebe o 404 de @ inexistente (PERM-03).
 */
export function isFollowAllowed(
  viewer: AuthContext,
  target: ProfileTarget,
  relation: Relationship,
): boolean {
  return (
    viewer.accountType === 'personal' &&
    target.accountType === 'creator' &&
    target.id !== viewer.userId &&
    !relation.blocked
  );
}

/**
 * Pedido de conexão (preparado para a Fase 4, X.2 CA2): entre duas contas pessoais diferentes e
 * sem bloqueio em nenhum sentido. A Fase 4 acrescenta a prova de presença (tokens de proximidade).
 */
export function isConnectionRequestAllowed(
  viewer: AuthContext,
  target: ProfileTarget,
  relation: Relationship,
): boolean {
  return (
    viewer.accountType === 'personal' &&
    target.accountType === 'personal' &&
    target.id !== viewer.userId &&
    !relation.blocked
  );
}

/**
 * Único ponto que decide visibilidade (arquitetura.md §5 e §7). Quem não pode ver recebe o mesmo
 * 404 de um recurso inexistente (PERM-13, PERM-14). Coberto por testes de permissão.
 */
@Injectable()
export class AccessPolicyService {
  constructor(
    private readonly relations: RelationsRepository,
    private readonly connections: ConnectionsRepository,
    private readonly clock: Clock,
  ) {}

  private relationTo(
    viewer: AuthContext,
    otherId: string,
    executor?: DbExecutor,
  ): Promise<Relationship> {
    return otherId === viewer.userId
      ? Promise.resolve(NO_RELATIONSHIP)
      : this.relations.relationship(viewer.userId, otherId, executor);
  }

  async canViewProfile(viewer: AuthContext, target: ProfileTarget): Promise<boolean> {
    return isProfileVisible(viewer, target, await this.relationTo(viewer, target.id));
  }

  async canViewPost(viewer: AuthContext, post: PostTarget): Promise<boolean> {
    // Nem com conexão e sem bloqueio daria para ver: não precisa consultar.
    if (!isPostVisible(viewer, post, { connected: true, blocked: false })) {
      return false;
    }
    return isPostVisible(viewer, post, await this.relationTo(viewer, post.authorId));
  }

  /** `executor`: a transação de quem segue, depois da trava do par (corrida com o bloqueio). */
  async canFollow(
    viewer: AuthContext,
    target: ProfileTarget,
    executor?: DbExecutor,
  ): Promise<boolean> {
    if (!isFollowAllowed(viewer, target, NO_RELATIONSHIP)) {
      return false;
    }
    return isFollowAllowed(viewer, target, await this.relationTo(viewer, target.id, executor));
  }

  /** Fase 4 (X.2 CA2): usado pelo pedido de conexão, por proximidade ou QR. */
  async canRequestConnection(
    viewer: AuthContext,
    target: ProfileTarget,
    executor?: DbExecutor,
  ): Promise<boolean> {
    if (!isConnectionRequestAllowed(viewer, target, NO_RELATIONSHIP)) {
      return false;
    }
    return isConnectionRequestAllowed(
      viewer,
      target,
      await this.relationTo(viewer, target.id, executor),
    );
  }

  /**
   * Fase 4: o pedido (ou o aceite) entre o leitor e `target` pode seguir? `denied`: tipo de conta,
   * a própria conta ou bloqueio em qualquer sentido (quem pede recebe a mensagem genérica, sem
   * revelar o bloqueio, X.2 CA2); `connected`: já são conexão (PROX-19); `allowed`. Uma consulta só,
   * com `executor` = a transação de quem conecta, depois da trava do par.
   */
  async connectionRequestState(
    viewer: AuthContext,
    target: ProfileTarget,
    executor?: DbExecutor,
  ): Promise<'allowed' | 'denied' | 'connected'> {
    if (!isConnectionRequestAllowed(viewer, target, NO_RELATIONSHIP)) {
      return 'denied';
    }
    const relation = await this.relationTo(viewer, target.id, executor);
    if (!isConnectionRequestAllowed(viewer, target, relation)) {
      return 'denied';
    }
    return relation.connected ? 'connected' : 'allowed';
  }

  /**
   * Há pedido de conexão entre o leitor e `targetId` (qualquer direção, qualquer status) criado na
   * janela de moderação (`CONNECTION_REQUEST_MODERATION_WINDOW_S`, 24 h, pelo `Clock`).
   */
  private hasRecentRequest(viewer: AuthContext, targetId: string): Promise<boolean> {
    const since = new Date(
      this.clock.now().getTime() - CONNECTION_REQUEST_MODERATION_WINDOW_S * 1000,
    );
    return this.connections.hasRecentRequestBetween(viewer.userId, targetId, since);
  }

  /**
   * Bloquear pelo @ (`POST /me/blocks {handle}`), e a base da denúncia de conta
   * (`canReportAccount`). `target`: a conta ativa do @ (`undefined` para @ inexistente, excluído ou
   * inválido). Pode quando:
   * - o leitor vê o perfil; ou
   * - (ADR 0013, no lugar da R1-5 do encosto) há pedido de conexão entre os dois, em qualquer
   *   direção e status, criado nas últimas 24 h: quem recebe o pedido de um desconhecido (que leu o
   *   QR ou o NFC, até de longe) pode bloquear e denunciar, não só recusar. Pedido só existe entre
   *   contas pessoais, então criador não ganha nada novo.
   * Quem não pode recebe a mesma resposta de sempre (sem oráculo).
   */
  async canBlockOrReport(viewer: AuthContext, target: ProfileTarget | undefined): Promise<boolean> {
    if (target === undefined) {
      return false;
    }
    if (await this.canViewProfile(viewer, target)) {
      return true;
    }
    return this.hasRecentRequest(viewer, target.id);
  }

  /**
   * Denunciar a conta pelo @ (`POST /reports`, `target.type = 'account'`): a regra de
   * `canBlockOrReport` (perfil visível ou pedido nas últimas 24 h) **mais** "quem denuncia bloqueou
   * o alvo" (R1-PO-1, aprovada pelo PO em 2026-10-30), sem prazo. Só nesse sentido: ter sido
   * bloqueado pelo alvo não conta. Post e comentário não mudam (seguem a visibilidade de sempre).
   *
   * `hasBlocked` e o pedido recente rodam juntos para **todo** alvo existente que o leitor não vê,
   * sem atalho pelo `blocked` da relação já lida: pular a consulta quando não há bloqueio em nenhum
   * sentido deixaria mais lento só o caso "o alvo bloqueou quem denuncia", e o tempo revelaria esse
   * bloqueio.
   */
  async canReportAccount(viewer: AuthContext, target: ProfileTarget | undefined): Promise<boolean> {
    if (target === undefined) {
      return false;
    }
    if (await this.canViewProfile(viewer, target)) {
      return true;
    }
    const [recentRequest, blockedByViewer] = await Promise.all([
      this.hasRecentRequest(viewer, target.id),
      this.relations.hasBlocked(viewer.userId, target.id),
    ]);
    return recentRequest || blockedByViewer;
  }

  /** O leitor (pessoal) segue o criador: o botão Seguir/Seguindo do perfil (3.4). */
  async isFollowing(viewer: AuthContext, creatorId: string): Promise<boolean> {
    if (viewer.accountType !== 'personal') {
      return false;
    }
    return this.relations.isFollowing(viewer.userId, creatorId);
  }

  /**
   * Quais perfis o leitor pode abrir (D11/A-07: o @ de quem comentou só é tocável se o perfil for
   * visível). Duas consultas para a lista inteira (conexões e bloqueios).
   */
  async visibleProfiles(
    viewer: AuthContext,
    targets: readonly ProfileTarget[],
  ): Promise<Set<string>> {
    const others = targets.filter((target) => target.id !== viewer.userId);
    const [connected, blocked] = await Promise.all([
      this.relations.connectedAmong(
        viewer.userId,
        others.filter((target) => target.accountType === 'personal').map((target) => target.id),
      ),
      this.relations.blockedAmong(
        viewer.userId,
        others.map((target) => target.id),
      ),
    ]);
    return new Set(
      targets
        .filter((target) =>
          isProfileVisible(viewer, target, {
            connected: connected.has(target.id),
            blocked: blocked.has(target.id),
          }),
        )
        .map((target) => target.id),
    );
  }

  /** Quais destas contas têm bloqueio com o leitor (para recusar um alvo sem consultar de novo). */
  async blockedAmong(viewer: AuthContext, accountIds: readonly string[]): Promise<Set<string>> {
    return this.relations.blockedAmong(viewer.userId, accountIds);
  }

  /**
   * Filtro SQL das listas com conteúdo de várias contas (X.2): esconde as contas com bloqueio com o
   * leitor, em qualquer sentido. Usado nos comentários (as duas pessoas deixam de ver os
   * comentários uma da outra em qualquer post) e na busca de criadores.
   */
  hideBlockedFor(viewer: AuthContext, accountColumn: SQL | { getSQL(): SQL }): SQL {
    return this.relations.notBlockedWith(viewer.userId, accountColumn);
  }

  /**
   * Filtro SQL (Fase 6) com a mesma regra de `canViewProfile`, para listas paginadas no banco: as
   * notificações cujo post é de outra conta (uma resposta num post de conexão) só aparecem enquanto
   * o leitor ainda vê o autor.
   */
  profileVisibleFilter(
    viewer: AuthContext,
    idColumn: SQL | { getSQL(): SQL },
    accountTypeColumn: SQL | { getSQL(): SQL },
  ): SQL {
    return this.relations.profileVisibleTo(viewer.userId, idColumn, accountTypeColumn);
  }

  /** Filtro SQL (Fase 6): a conta da coluna é conexão do leitor (notificação de conexão). */
  connectedFilter(viewer: AuthContext, accountColumn: SQL | { getSQL(): SQL }): SQL {
    return this.relations.connectedWith(viewer.userId, accountColumn);
  }
}
