import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  type ConnectionRequestRow,
  connectionRequests,
  connections,
  type Database,
  type DbExecutor,
  type DbHandle,
  eq,
  gt,
  isNull,
  lte,
  or,
  type RequestStatusValue,
  type SQL,
  sql,
  users,
} from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

/** A outra pessoa de um pedido, com o que a folha e a tela "Aguardando" mostram. */
export interface RequestParty {
  id: string;
  handle: string;
  name: string;
  avatarKey: string | null;
}

export interface RequestWithParty {
  request: ConnectionRequestRow;
  other: RequestParty;
}

/** Par ordenado da tabela `connections` (`user_a_id < user_b_id`). */
function orderedPair(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}

/** As duas direções entre `first` e `second`. */
function betweenPair(first: string, second: string): SQL | undefined {
  return or(
    and(eq(connectionRequests.fromId, first), eq(connectionRequests.toId, second)),
    and(eq(connectionRequests.fromId, second), eq(connectionRequests.toId, first)),
  );
}

const partyColumns = {
  id: users.id,
  handle: users.handle,
  name: users.name,
  avatarKey: users.avatarKey,
};

/**
 * Pedidos de conexão e a tabela `connections` (arquitetura.md §5, módulo `connections`). As
 * escritas do par rodam na transação de quem chama, depois de `lockAccountPair`. Nenhuma função
 * lista conexões: a lista própria fica no `own-lists` (ADR 0004).
 */
@Injectable()
export class ConnectionsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  /** Marca como vencidos os pendentes do par que passaram do prazo (expiração preguiçosa). */
  async expireStaleBetween(tx: DbExecutor, first: string, second: string, now: Date) {
    await tx
      .update(connectionRequests)
      .set({ status: 'expired', respondedAt: now })
      .where(
        and(
          eq(connectionRequests.status, 'pending'),
          lte(connectionRequests.expiresAt, now),
          betweenPair(first, second),
        ),
      );
  }

  /** O pendente `from → to` (depois de `expireStaleBetween`, ainda no prazo). */
  async findPending(
    tx: DbExecutor,
    fromId: string,
    toId: string,
  ): Promise<ConnectionRequestRow | undefined> {
    const [row] = await tx
      .select()
      .from(connectionRequests)
      .where(
        and(
          eq(connectionRequests.fromId, fromId),
          eq(connectionRequests.toId, toId),
          eq(connectionRequests.status, 'pending'),
        ),
      )
      .limit(1);
    return row;
  }

  async insertPending(
    tx: DbExecutor,
    values: { fromId: string; toId: string; method: 'ble' | 'qr'; now: Date; expiresAt: Date },
  ): Promise<ConnectionRequestRow> {
    const [row] = await tx
      .insert(connectionRequests)
      .values({
        fromId: values.fromId,
        toId: values.toId,
        method: values.method,
        createdAt: values.now,
        expiresAt: values.expiresAt,
      })
      .returning();
    if (row === undefined) {
      throw new Error('insertPending: o INSERT não devolveu a linha');
    }
    return row;
  }

  /** A linha do pedido travada até o fim da transação (aceite, recusa e cancelamento). */
  async lockRequest(tx: DbExecutor, id: string): Promise<ConnectionRequestRow | undefined> {
    const [row] = await tx
      .select()
      .from(connectionRequests)
      .where(eq(connectionRequests.id, id))
      .for('update');
    return row;
  }

  /** Fecha um pendente (`accepted`, `declined`, `cancelled` ou `expired`). */
  async close(
    tx: DbExecutor,
    id: string,
    status: Exclude<RequestStatusValue, 'pending'>,
    now: Date,
  ): Promise<ConnectionRequestRow | undefined> {
    const [row] = await tx
      .update(connectionRequests)
      .set({ status, respondedAt: now })
      .where(and(eq(connectionRequests.id, id), eq(connectionRequests.status, 'pending')))
      .returning();
    return row;
  }

  /** Cria a conexão (par ordenado) com o método do pedido aceito. Idempotente (PROX-19). */
  async insertConnection(
    tx: DbExecutor,
    first: string,
    second: string,
    values: { method: 'ble' | 'qr'; requestId: string; now: Date },
  ): Promise<boolean> {
    const [userAId, userBId] = orderedPair(first, second);
    const inserted = await tx
      .insert(connections)
      .values({
        userAId,
        userBId,
        method: values.method,
        requestId: values.requestId,
        createdAt: values.now,
      })
      .onConflictDoNothing()
      .returning({ userAId: connections.userAId });
    // Fase 6: só a conexão nova gera a notificação (PROX-29).
    return inserted.length > 0;
  }

  /** Desfaz a conexão do par (D8). Devolve se havia conexão. */
  async deleteConnection(tx: DbExecutor, first: string, second: string): Promise<boolean> {
    const [userAId, userBId] = orderedPair(first, second);
    const removed = await tx
      .delete(connections)
      .where(and(eq(connections.userAId, userAId), eq(connections.userBId, userBId)))
      .returning({ userAId: connections.userAId });
    return removed.length > 0;
  }

  /** `from` teve um pedido para `to` recusado depois de `since` (intervalo de 1 h, PROX-17). */
  async declinedSince(tx: DbExecutor, fromId: string, toId: string, since: Date) {
    const [row] = await tx
      .select({ id: connectionRequests.id })
      .from(connectionRequests)
      .where(
        and(
          eq(connectionRequests.fromId, fromId),
          eq(connectionRequests.toId, toId),
          eq(connectionRequests.status, 'declined'),
          gt(connectionRequests.respondedAt, since),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * O pedido `id`, se `viewerId` é uma das duas pessoas, com a outra pessoa ativa e visível
   * (`visible`: o filtro de bloqueio da política). Para qualquer outro caso, `undefined`: terceiro,
   * conta excluída ou bloqueio recebem o mesmo 404 (PROX-12, PROX-27).
   */
  async findForParty(
    id: string,
    viewerId: string,
    visible: SQL,
  ): Promise<RequestWithParty | undefined> {
    const [row] = await this.db
      .select({ request: connectionRequests, other: partyColumns })
      .from(connectionRequests)
      .innerJoin(
        users,
        sql`${users.id} = case when ${connectionRequests.fromId} = ${viewerId}
                               then ${connectionRequests.toId} else ${connectionRequests.fromId} end`,
      )
      .where(
        and(
          eq(connectionRequests.id, id),
          or(eq(connectionRequests.fromId, viewerId), eq(connectionRequests.toId, viewerId)),
          isNull(users.deletedAt),
          visible,
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Pendentes **para** `viewerId` ainda no prazo, do mais antigo para o mais novo, de contas ativas
   * e visíveis (sem bloqueio). Pelo índice `connection_requests_to_idx`.
   */
  async listIncoming(
    viewerId: string,
    now: Date,
    visible: SQL,
    limit: number,
  ): Promise<RequestWithParty[]> {
    return this.db
      .select({ request: connectionRequests, other: partyColumns })
      .from(connectionRequests)
      .innerJoin(users, eq(users.id, connectionRequests.fromId))
      .where(
        and(
          eq(connectionRequests.toId, viewerId),
          eq(connectionRequests.status, 'pending'),
          gt(connectionRequests.expiresAt, now),
          isNull(users.deletedAt),
          visible,
        ),
      )
      .orderBy(asc(connectionRequests.createdAt), asc(connectionRequests.id))
      .limit(limit);
  }

  /**
   * Cancela os pendentes em que a conta é uma das partes (logout e exclusão, PROX-27): o aceite
   * passa a dar 404 e quem pediu vê "não confirmado".
   */
  async cancelPendingInvolving(executor: DbExecutor, userId: string, now: Date): Promise<void> {
    await executor
      .update(connectionRequests)
      .set({ status: 'cancelled', respondedAt: now })
      .where(
        and(
          eq(connectionRequests.status, 'pending'),
          or(eq(connectionRequests.fromId, userId), eq(connectionRequests.toId, userId)),
        ),
      );
  }
}
