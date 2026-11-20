import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  type Database,
  type DbExecutor,
  type DbHandle,
  eq,
  follows,
  isNull,
  qualified,
  type SQL,
  sql,
  users,
} from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

/** Criador encontrado pela busca, antes de montar a resposta. */
export interface CreatorSearchRow {
  id: string;
  handle: string;
  name: string;
  avatarKey: string | null;
  followedByMe: boolean;
}

/**
 * `_` e `%` viram texto no LIKE (BUS-06). O `q` já chega só com `[a-z0-9._]`, mas o escape fica
 * aqui, junto da consulta, para nunca depender da validação de fora.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Seguir, deixar de seguir e a busca de criadores (arquitetura.md §5, módulo `follows`). */
@Injectable()
export class FollowsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  /**
   * Idempotente (PERM-04): seguir de novo não cria outra linha. A FK composta garante o tipo.
   * `true` se o follow é novo (Fase 6: só ele soma na notificação de seguidores).
   */
  async follow(
    executor: DbExecutor,
    personId: string,
    creatorId: string,
    now: Date,
  ): Promise<boolean> {
    const inserted = await executor
      .insert(follows)
      .values({ followerId: personId, creatorId, createdAt: now })
      .onConflictDoNothing()
      .returning({ creatorId: follows.creatorId });
    return inserted.length > 0;
  }

  /** Idempotente: deixar de seguir quem não segue não faz nada. */
  async unfollow(personId: string, creatorId: string): Promise<void> {
    await this.db
      .delete(follows)
      .where(and(eq(follows.followerId, personId), eq(follows.creatorId, creatorId)));
  }

  /**
   * Criadores ativos cujo @ começa com `prefix` (3.1): pelo índice parcial
   * `users_creator_handle_prefix_idx` (collation "C"), em ordem alfabética do @, no máximo `limit`.
   * Conta pessoal nunca entra: o filtro de tipo está na consulta, sem outra consulta para @ pessoal
   * (a resposta e o tempo são os mesmos de um @ inexistente, BUS-05). `visible` é o filtro da
   * política (X.2: sem criadores com bloqueio com o leitor).
   *
   * `followedByMe` usa a linha de fora com `qualified(users.id)` (`"users"."id"`), e não com
   * `${users.id}`, que o Drizzle escreveria `"id"` na lista do `select` sem `join` (R25).
   */
  async searchCreators(
    viewerId: string,
    prefix: string,
    limit: number,
    visible: SQL,
  ): Promise<CreatorSearchRow[]> {
    const pattern = `${escapeLikePattern(prefix)}%`;
    const rows = await this.db
      .select({
        id: users.id,
        handle: users.handle,
        name: users.name,
        avatarKey: users.avatarKey,
        followedByMe: sql<boolean>`exists (
          select 1 from follows f
           where f.follower_id = ${viewerId} and f.creator_id = ${qualified(users.id)})`,
      })
      .from(users)
      .where(
        and(
          eq(users.accountType, 'creator'),
          isNull(users.deletedAt),
          sql`(${users.handle} collate "C") like ${pattern} escape '\\'`,
          visible,
        ),
      )
      .orderBy(sql`(${users.handle} collate "C")`)
      .limit(limit);
    return rows;
  }
}
