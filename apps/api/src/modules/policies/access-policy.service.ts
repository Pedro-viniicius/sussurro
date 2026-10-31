import { Injectable } from '@nestjs/common';
import type { DbExecutor, SQL } from '@sussurro/db';
import type { AccountType, PostStatus } from '@sussurro/shared';

import { NO_RELATIONSHIP, type Relationship, RelationsRepository } from './relations.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';

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
 * Bloquear e denunciar pelo cartão do encosto (ADR 0012, A2 rev. 1, R1-5; decisão do PO, opção
 * (a)): entre duas contas pessoais diferentes com **par encostado vivo** (`touchPair`, até 60 s
 * depois do último casamento). Vale mesmo que um dos dois já tenha bloqueado o outro. Regra pura
 * sobre o fato já consultado; quem o consulta é o `proximity` (só ele fala com o Valkey).
 */
export function isTouchActionAllowed(
  viewer: AuthContext,
  target: ProfileTarget,
  touchPair: boolean,
): boolean {
  return (
    touchPair &&
    viewer.accountType === 'personal' &&
    target.accountType === 'personal' &&
    target.id !== viewer.userId
  );
}

/**
 * Uma das duas contas de um encosto como a política a vê (ADR 0012, A3-1, R22): os fatos chegam em
 * colunas (`ProximityRepository.findTouchPair`), e não no `WHERE`, para o banco fazer o mesmo
 * trabalho com ou sem bloqueio. `blocked` é do **par**: o mesmo valor nas duas linhas.
 */
export interface TouchParty {
  id: string;
  /** Conta pessoal (`account_type = 'personal'`). */
  personal: boolean;
  /** Conta não excluída (`deleted_at is null`). */
  active: boolean;
  /** Há bloqueio entre as duas contas, em qualquer sentido. */
  blocked: boolean;
}

/** As duas contas de um encosto que pode revelar os cartões. */
export interface TouchRevealParties<T extends TouchParty> {
  /** O dono do `bleToken` relatado. */
  owner: T;
  /** Quem relatou. */
  caller: T;
}

/**
 * Revelar os cartões no encosto (ADR 0012 §3 e A3-1; X.2 CA2): o dono do token e quem chama
 * existem, são contas diferentes, pessoais e ativas, e não há bloqueio entre elas em nenhum
 * sentido. É a regra do `findNearby` com o `hideBlockedFor` (o mesmo filtro do QR), decidida sobre
 * as colunas. Regra pura: devolve as duas linhas, ou `null` na recusa, e quem chama só tem o cartão
 * de uma conta por este retorno (a linha recusada, com @, nome e foto, não sai daqui).
 */
export function touchRevealParties<T extends TouchParty>(
  viewer: AuthContext,
  ownerId: string,
  rows: readonly T[],
): TouchRevealParties<T> | null {
  const owner = rows.find((row) => row.id === ownerId);
  const caller = rows.find((row) => row.id === viewer.userId);
  if (
    owner === undefined ||
    caller === undefined ||
    owner.id === caller.id ||
    !owner.personal ||
    !owner.active ||
    !caller.personal ||
    !caller.active ||
    owner.blocked
  ) {
    return null;
  }
  return { owner, caller };
}

/**
 * Único ponto que decide visibilidade (arquitetura.md §5 e §7). Quem não pode ver recebe o mesmo
 * 404 de um recurso inexistente (PERM-13, PERM-14). Coberto por testes de permissão.
 */
@Injectable()
export class AccessPolicyService {
  constructor(private readonly relations: RelationsRepository) {}

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
   * (ADR 0012, A2 rev. 1, R1-5) Bloquear pelo @ (`POST /me/blocks {handle}`), e a base da denúncia
   * de conta (`canReportAccount`): quem o leitor vê, como sempre, **ou**, entre contas pessoais,
   * quem tem par encostado vivo com ele (o cartão do encosto, 60 s). `target`: a conta ativa do @
   * (`undefined` para @ inexistente, excluído ou inválido). `touchPair(targetId)`: o fato "o par
   * vive", do `proximity`.
   *
   * Sem oráculo: alvo visível decide sem consultar o par (o bloqueio de uma conexão nunca depende do
   * Valkey); qualquer outro alvo consulta o par **sempre**, mesmo sem conta (com `undefined`), para o
   * tempo e a falha (503) serem os mesmos para @ existente, inexistente, excluído e inválido. Ninguém
   * consome o par: bloquear e denunciar, em qualquer ordem e nos dois sentidos, passam enquanto ele
   * vive. A regra "denunciar quem você bloqueou" (R1-PO-1) é só da denúncia, não do bloqueio.
   */
  async canBlockOrReport(
    viewer: AuthContext,
    target: ProfileTarget | undefined,
    touchPair: (targetId: string | undefined) => Promise<boolean>,
  ): Promise<boolean> {
    if (target !== undefined && (await this.canViewProfile(viewer, target))) {
      return true;
    }
    return this.touchPairAllows(viewer, target, touchPair);
  }

  /**
   * Denunciar a conta pelo @ (`POST /reports`, `target.type = 'account'`): a regra de
   * `canBlockOrReport` **mais** "quem denuncia bloqueou o alvo" (R1-PO-1, aprovada pelo PO em
   * 2026-10-30), sem prazo. Só nesse sentido: ter sido bloqueado pelo alvo não conta. Post e
   * comentário não mudam (seguem a visibilidade de sempre).
   *
   * Ordem, sem oráculo:
   * 1. perfil visível → pode, sem consultar o par (como em `canBlockOrReport`);
   * 2. alvo existente que o leitor bloqueou → pode, **sem** consultar o par: com o Valkey fora, a
   *    denúncia de quem você bloqueou não dá 503. Não revela nada novo a quem denuncia: o
   *    `GET /me/blocks` já lhe mostra as contas ativas que bloqueou, com o @ atual. E a linha em
   *    `blocks` só existe se o bloqueio foi gravado, o que já exigiu ver o perfil ou o par vivo;
   * 3. senão, o par encostado, consultado **sempre** (também com `undefined`), como em
   *    `canBlockOrReport`: o 503 e o tempo continuam iguais para @ inexistente, excluído, inválido
   *    e para quem só foi bloqueado pelo alvo.
   *
   * `hasBlocked` roda para **todo** alvo existente que o leitor não vê, sem atalho pelo `blocked`
   * da relação já lida: pular a consulta quando não há bloqueio em nenhum sentido deixaria mais
   * lento só o caso "o alvo bloqueou quem denuncia", e o tempo revelaria esse bloqueio.
   */
  async canReportAccount(
    viewer: AuthContext,
    target: ProfileTarget | undefined,
    touchPair: (targetId: string | undefined) => Promise<boolean>,
  ): Promise<boolean> {
    if (target !== undefined) {
      if (await this.canViewProfile(viewer, target)) {
        return true;
      }
      if (await this.relations.hasBlocked(viewer.userId, target.id)) {
        return true;
      }
    }
    return this.touchPairAllows(viewer, target, touchPair);
  }

  /** O par encostado, consultado sempre, mesmo sem conta (R1-5; ver `canBlockOrReport`). */
  private async touchPairAllows(
    viewer: AuthContext,
    target: ProfileTarget | undefined,
    touchPair: (targetId: string | undefined) => Promise<boolean>,
  ): Promise<boolean> {
    const paired = await touchPair(target?.id);
    return target !== undefined && isTouchActionAllowed(viewer, target, paired);
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
   * (ADR 0012, A3-1, R22) O encosto pode revelar os cartões? A regra de `touchRevealParties`, sobre
   * as duas linhas do `findTouchPair` (já lidas: aqui não há consulta, para o caminho do `touches`
   * ter as mesmas idas em todo caso).
   */
  touchRevealParties<T extends TouchParty>(
    viewer: AuthContext,
    ownerId: string,
    rows: readonly T[],
  ): TouchRevealParties<T> | null {
    return touchRevealParties(viewer, ownerId, rows);
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
