import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  blocks,
  connectionRequests,
  connections,
  type Database,
  type DbExecutor,
  type DbHandle,
  eq,
  follows,
  or,
  sql,
} from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

/**
 * Gravação dos bloqueios (X.2). As leituras ("há bloqueio?") ficam no `RelationsRepository`, da
 * política; a lista do dono, no `OwnListsRepository`. Bloquear desfaz as relações do par aqui
 * mesmo, na transação do bloqueio, com a mesma trava do par de seguir e conectar.
 */
@Injectable()
export class BlocksRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  /** Idempotente: bloquear de novo não cria outra linha nem muda a data. */
  async insert(executor: DbExecutor, blockerId: string, blockedId: string, now: Date) {
    await executor
      .insert(blocks)
      .values({ blockerId, blockedId, createdAt: now })
      .onConflictDoNothing();
  }

  /**
   * Desfaz a conexão (par ordenado) e os follows nos dois sentidos (X.2 CA3). Os contadores são
   * `COUNT(*)` na leitura: conexões e "criadores" mudam na hora; "seguidores", em até 60 s (cache).
   * Fase 4: os pedidos de conexão pendentes do par são cancelados (o aceite passa a dar 404).
   */
  async removeRelations(
    executor: DbExecutor,
    first: string,
    second: string,
    now: Date,
  ): Promise<void> {
    const [userAId, userBId] = first < second ? [first, second] : [second, first];
    await executor
      .delete(connections)
      .where(and(eq(connections.userAId, userAId), eq(connections.userBId, userBId)));
    await executor
      .update(connectionRequests)
      .set({ status: 'cancelled', respondedAt: now })
      .where(
        and(
          eq(connectionRequests.status, 'pending'),
          or(
            and(eq(connectionRequests.fromId, first), eq(connectionRequests.toId, second)),
            and(eq(connectionRequests.fromId, second), eq(connectionRequests.toId, first)),
          ),
        ),
      );
    await executor
      .delete(follows)
      .where(
        or(
          and(eq(follows.followerId, first), eq(follows.creatorId, second)),
          and(eq(follows.followerId, second), eq(follows.creatorId, first)),
        ),
      );
  }

  /** Desbloquear pelo @ (idempotente). Só apaga o bloqueio que `blockerId` fez. */
  async deleteByHandle(blockerId: string, handle: string): Promise<void> {
    await this.db
      .delete(blocks)
      .where(
        and(
          eq(blocks.blockerId, blockerId),
          sql`${blocks.blockedId} in (select u.id from users u where u.handle = ${handle})`,
        ),
      );
  }
}
