import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  type Database,
  type DbHandle,
  eq,
  follows,
  inArray,
  isNull,
  sql,
  users,
} from '@sussurro/db';

import type { ProfileCountValues, ProfileRow } from './profile.mapper.js';
import { rowsOf } from '../../common/db/rows.js';
import { DATABASE } from '../../infra/database/database.providers.js';

const profileColumns = {
  id: users.id,
  email: users.email,
  handle: users.handle,
  name: users.name,
  bio: users.bio,
  avatarKey: users.avatarKey,
  accountType: users.accountType,
  emailVerifiedAt: users.emailVerifiedAt,
  createdAt: users.createdAt,
};

export interface ProfileChanges {
  name?: string;
  bio?: string | null;
}

/** Consultas de perfil da tabela `users`. Contas excluídas nunca aparecem (CONTA-02). */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  private get db(): Database {
    return this.database.db;
  }

  async findActiveById(id: string): Promise<ProfileRow | undefined> {
    const [row] = await this.db
      .select(profileColumns)
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row;
  }

  async findActiveByHandle(handle: string): Promise<ProfileRow | undefined> {
    const [row] = await this.db
      .select(profileColumns)
      .from(users)
      .where(and(eq(users.handle, handle), isNull(users.deletedAt)))
      .limit(1);
    return row;
  }

  async updateProfile(
    id: string,
    changes: ProfileChanges,
    now: Date,
  ): Promise<ProfileRow | undefined> {
    const [row] = await this.db
      .update(users)
      .set({ ...changes, updatedAt: now })
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .returning(profileColumns);
    return row;
  }

  /**
   * Números do perfil com `COUNT(*)` na leitura (ADR 0004). Publicações = publicadas e não
   * excluídas, dos três tipos (A-30; rascunho, processando e falha não contam, CNT-05). Conexões e
   * criadores ignoram contas excluídas na hora (A-11, CNT-03). Seguidores de criador vêm do
   * `FollowerCountsService` (cache de 60 s, CNT-02), não daqui.
   */
  async counts(userId: string): Promise<Omit<ProfileCountValues, 'followers'>> {
    const result = await this.db.execute(sql`
      select
        (select count(*)::int from posts p
          where p.author_id = ${userId} and p.status = 'published' and p.deleted_at is null) as posts,
        (select count(*)::int from connections c join users u on u.id = c.user_b_id
          where c.user_a_id = ${userId} and u.deleted_at is null)
        + (select count(*)::int from connections c join users u on u.id = c.user_a_id
          where c.user_b_id = ${userId} and u.deleted_at is null) as connections,
        (select count(*)::int from follows f join users u on u.id = f.creator_id
          where f.follower_id = ${userId} and u.deleted_at is null) as creators
    `);
    const [row] = rowsOf<Record<'posts' | 'connections' | 'creators', number | string>>(result);
    return {
      posts: Number(row?.posts ?? 0),
      connections: Number(row?.connections ?? 0),
      creators: Number(row?.creators ?? 0),
    };
  }

  /**
   * Seguidores de cada criador: follows de contas pessoais não excluídas (CNT-02, CNT-03), numa
   * consulta só (perfil e busca). Pelo índice `follows_creator_idx`.
   */
  async followerCounts(creatorIds: readonly string[]): Promise<Map<string, number>> {
    if (creatorIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({ creatorId: follows.creatorId, total: sql<number>`count(*)::int` })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followerId))
      .where(and(inArray(follows.creatorId, [...creatorIds]), isNull(users.deletedAt)))
      .groupBy(follows.creatorId);
    return new Map(rows.map((row) => [row.creatorId, row.total]));
  }
}
