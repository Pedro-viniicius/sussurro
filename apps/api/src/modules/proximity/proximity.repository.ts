import { Inject, Injectable } from '@nestjs/common';
import { and, type DbHandle, eq, inArray, isNull, type SQL, sql, users } from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

/** Dono de um token resolvido, com o que o cartão "Por perto" mostra. */
export interface NearbyRow {
  id: string;
  handle: string;
  name: string;
  avatarKey: string | null;
  connected: boolean;
}

/**
 * Uma das duas contas do encosto (`findTouchPair`), com o que a política decide em colunas, não no
 * `WHERE` (ADR 0012, A3-1, R22). `connected` e `blocked` são do **par**: o mesmo valor nas duas
 * linhas.
 */
export interface TouchPairRow {
  id: string;
  handle: string;
  name: string;
  avatarKey: string | null;
  /** `account_type = 'personal'`. */
  personal: boolean;
  /** `deleted_at is null` (a conta não foi excluída). */
  active: boolean;
  /** As duas contas são conexão. */
  connected: boolean;
  /** Há bloqueio entre as duas, em qualquer sentido. */
  blocked: boolean;
}

/**
 * Leitura das contas por trás dos tokens resolvidos (arquitetura.md §5: a proximidade não grava no
 * Postgres). `findNearby` (QR): só contas pessoais ativas; `visible` é o filtro de bloqueio da
 * política (X.2). `findTouchPair` (encosto): as duas contas, sem filtro, e a decisão fica no
 * service.
 */
@Injectable()
export class ProximityRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  async findNearby(viewerId: string, ids: readonly string[], visible: SQL): Promise<NearbyRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.database.db
      .select({
        id: users.id,
        handle: users.handle,
        name: users.name,
        avatarKey: users.avatarKey,
        connected: sql<boolean>`exists (
          select 1 from connections c
           where (c.user_a_id = ${viewerId} and c.user_b_id = ${users.id})
              or (c.user_b_id = ${viewerId} and c.user_a_id = ${users.id}))`,
      })
      .from(users)
      .where(
        and(
          inArray(users.id, [...ids]),
          eq(users.accountType, 'personal'),
          isNull(users.deletedAt),
          visible,
        ),
      );
  }

  /**
   * As duas contas de um encosto, quem chama e o dono do `bleToken`, só para o `touches` (ADR 0012,
   * A3-1, R22). O `WHERE` filtra só pelos ids, então voltam as duas linhas sempre que as duas
   * contas existem, com bloqueio, conta excluída ou de criador. A recusa é decidida pelo service a
   * partir das colunas `personal`, `active` e `blocked`. Assim o número de linhas e o plano são
   * os mesmos em todos os casos, e o tempo não revela bloqueio. No `findNearby`, o filtro de
   * bloqueio no `WHERE` mudava o número de linhas e de execuções do subplano.
   *
   * `connected` e `blocked` não dependem da linha: cada um vira um InitPlan que roda uma vez por
   * consulta, com 1 busca por índice na conexão e 1 em cada sentido do bloqueio. As duas buscas do
   * bloqueio são somadas em vez de ligadas por `or`, que pararia na primeira encontrada. Planos
   * medidos no PGlite (com e sem estatísticas): `users_pkey` + 3 Index Only Scans
   * (`connections_user_b_idx` ou a PK, `blocks_blocked_idx` ou a PK), sem seq scan.
   *
   * `viewerId` e `ownerId` são contas diferentes: o service descarta o token da própria conta.
   */
  async findTouchPair(viewerId: string, ownerId: string): Promise<TouchPairRow[]> {
    return this.database.db
      .select({
        id: users.id,
        handle: users.handle,
        name: users.name,
        avatarKey: users.avatarKey,
        personal: sql<boolean>`${users.accountType} = 'personal'`,
        active: sql<boolean>`${users.deletedAt} is null`,
        connected: sql<boolean>`exists (
          select 1 from connections c
           where c.user_a_id = least(${viewerId}::uuid, ${ownerId}::uuid)
             and c.user_b_id = greatest(${viewerId}::uuid, ${ownerId}::uuid))`,
        blocked: sql<boolean>`((exists (
            select 1 from blocks b where b.blocker_id = ${viewerId} and b.blocked_id = ${ownerId}))::int
          + (exists (
            select 1 from blocks b where b.blocker_id = ${ownerId} and b.blocked_id = ${viewerId}))::int) > 0`,
      })
      .from(users)
      .where(inArray(users.id, [ownerId, viewerId]));
  }
}
