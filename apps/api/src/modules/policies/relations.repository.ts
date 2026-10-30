import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  blocks,
  connections,
  type DbExecutor,
  type DbHandle,
  eq,
  follows,
  inArray,
  or,
  type SQL,
  sql,
} from '@sussurro/db';

import { rowsOf } from '../../common/db/rows.js';
import { DATABASE } from '../../infra/database/database.providers.js';

/** Par ordenado da tabela `connections` (`user_a_id < user_b_id`). */
function orderedPair(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}

/** O que a política precisa saber da relação entre o leitor e outra conta. */
export interface Relationship {
  /** São conexão (par em `connections`). */
  connected: boolean;
  /** Há bloqueio em qualquer sentido (um bloqueou o outro). */
  blocked: boolean;
}

/** Nenhuma relação: o padrão para a própria conta. */
export const NO_RELATIONSHIP: Relationship = { connected: false, blocked: false };

/**
 * Leituras de relacionamento usadas só pelo `AccessPolicyService` (arquitetura.md §5). Nunca
 * devolve listas para fora da política: só responde "é conexão?", "há bloqueio?" e "segue?" (ADR
 * 0004). As listas próprias ficam no módulo `own-lists`, com regra de lint própria.
 */
@Injectable()
export class RelationsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  /**
   * Conexão e bloqueio (nos dois sentidos) entre duas contas, numa consulta só. Com `executor`,
   * roda dentro da transação de quem chama (seguir e bloquear, depois da trava do par).
   */
  async relationship(
    viewerId: string,
    otherId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<Relationship> {
    if (viewerId === otherId) {
      return NO_RELATIONSHIP;
    }
    const [userAId, userBId] = orderedPair(viewerId, otherId);
    const result = await executor.execute(sql`
      select
        exists(select 1 from connections c
                where c.user_a_id = ${userAId} and c.user_b_id = ${userBId}) as connected,
        exists(select 1 from blocks b
                where (b.blocker_id = ${viewerId} and b.blocked_id = ${otherId})
                   or (b.blocker_id = ${otherId} and b.blocked_id = ${viewerId})) as blocked
    `);
    const [row] = rowsOf<{ connected: boolean; blocked: boolean }>(result);
    return { connected: row?.connected === true, blocked: row?.blocked === true };
  }

  /** Quais de `others` são conexão de `viewerId` (uma consulta só, para listas de comentários). */
  async connectedAmong(viewerId: string, others: readonly string[]): Promise<Set<string>> {
    const candidates = [...new Set(others)].filter((id) => id !== viewerId);
    if (candidates.length === 0) {
      return new Set();
    }
    const rows = await this.database.db
      .select({ a: connections.userAId, b: connections.userBId })
      .from(connections)
      .where(
        or(
          and(eq(connections.userAId, viewerId), inArray(connections.userBId, candidates)),
          and(eq(connections.userBId, viewerId), inArray(connections.userAId, candidates)),
        ),
      );
    return new Set(rows.map((row) => (row.a === viewerId ? row.b : row.a)));
  }

  /** Quais de `others` têm bloqueio com `viewerId`, em qualquer sentido (uma consulta só). */
  async blockedAmong(viewerId: string, others: readonly string[]): Promise<Set<string>> {
    const candidates = [...new Set(others)].filter((id) => id !== viewerId);
    if (candidates.length === 0) {
      return new Set();
    }
    const rows = await this.database.db
      .select({ blocker: blocks.blockerId, blocked: blocks.blockedId })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, viewerId), inArray(blocks.blockedId, candidates)),
          and(eq(blocks.blockedId, viewerId), inArray(blocks.blockerId, candidates)),
        ),
      );
    return new Set(rows.map((row) => (row.blocker === viewerId ? row.blocked : row.blocker)));
  }

  async isFollowing(personId: string, creatorId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ creatorId: follows.creatorId })
      .from(follows)
      .where(and(eq(follows.followerId, personId), eq(follows.creatorId, creatorId)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Condição SQL "a conta em `column` não tem bloqueio com `viewerId`", para as consultas que
   * listam contas ou conteúdo de várias contas (busca, comentários) filtrarem no banco, sem
   * quebrar a paginação. O `NOT EXISTS` usa a PK de `blocks` e o índice `blocks_blocked_idx`.
   */
  notBlockedWith(viewerId: string, column: SQL | { getSQL(): SQL }): SQL {
    return sql`not exists (
      select 1 from blocks b
       where (b.blocker_id = ${viewerId} and b.blocked_id = ${column})
          or (b.blocker_id = ${column} and b.blocked_id = ${viewerId}))`;
  }

  /** Filtro SQL (Fase 6): a conta da coluna é conexão do leitor. */
  connectedWith(viewerId: string, column: SQL | { getSQL(): SQL }): SQL {
    return sql`exists (
      select 1 from connections c
       where (c.user_a_id = ${viewerId} and c.user_b_id = ${column})
          or (c.user_b_id = ${viewerId} and c.user_a_id = ${column}))`;
  }

  /**
   * Filtro SQL (Fase 6) com a regra de `isProfileVisible`: a própria conta; sem bloqueio, criador
   * ou conexão. Usado onde a lista vem de várias contas e a regra precisa ir para o `WHERE`.
   */
  profileVisibleTo(
    viewerId: string,
    idColumn: SQL | { getSQL(): SQL },
    typeColumn: SQL | { getSQL(): SQL },
  ): SQL {
    return sql`(${idColumn} = ${viewerId} or (${this.notBlockedWith(viewerId, idColumn)} and (${typeColumn} = 'creator' or ${this.connectedWith(viewerId, idColumn)})))`;
  }
}
