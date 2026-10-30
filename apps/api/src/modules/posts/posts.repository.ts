import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  type Database,
  type DbExecutor,
  type DbHandle,
  eq,
  inArray,
  isNull,
  likes,
  type NewPostMediaRow,
  postMedia,
  type PostMediaRow,
  posts,
  type SQL,
  sql,
  users,
} from '@sussurro/db';
import type { AccountType, PostStatus, PostType } from '@sussurro/shared';

import { DATABASE } from '../../infra/database/database.providers.js';

/** Post com o que a resposta e a política de acesso precisam do autor. */
export interface PostRecord {
  id: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  authorAvatarKey: string | null;
  authorType: AccountType;
  authorDeletedAt: Date | null;
  type: PostType;
  status: PostStatus;
  text: string | null;
  caption: string | null;
  likeCount: number;
  commentCount: number;
  createdAt: Date;
  publishedAt: Date | null;
  deletedAt: Date | null;
}

export const postRecordColumns = {
  id: posts.id,
  authorId: posts.authorId,
  authorHandle: users.handle,
  authorName: users.name,
  authorAvatarKey: users.avatarKey,
  authorType: users.accountType,
  authorDeletedAt: users.deletedAt,
  type: posts.type,
  status: posts.status,
  text: posts.text,
  caption: posts.caption,
  likeCount: posts.likeCount,
  commentCount: posts.commentCount,
  createdAt: posts.createdAt,
  publishedAt: posts.publishedAt,
  deletedAt: posts.deletedAt,
};

/** Posição na lista do perfil: chave de ordenação (ms) e id (desempate). */
export interface PageAnchor {
  at: Date;
  id: string;
}

export interface AuthorPostsQuery {
  authorId: string;
  type: PostType;
  /** O dono vê também `processing` e `failed` (MID-09); os outros, só `published`. */
  includePending: boolean;
  after: PageAnchor | undefined;
  limit: number;
}

/** Item da lista do perfil com a chave de ordenação (vai para o cursor). */
export interface AuthorPostRecord extends PostRecord {
  sortAt: Date;
}

@Injectable()
export class PostsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  async findById(id: string, executor: DbExecutor = this.db): Promise<PostRecord | undefined> {
    const [row] = await executor
      .select(postRecordColumns)
      .from(posts)
      .innerJoin(users, eq(users.id, posts.authorId))
      .where(eq(posts.id, id))
      .limit(1);
    return row;
  }

  async insertTextPost(input: { authorId: string; text: string; now: Date }): Promise<string> {
    const [row] = await this.db
      .insert(posts)
      .values({
        authorId: input.authorId,
        type: 'text',
        status: 'published',
        text: input.text,
        createdAt: input.now,
        publishedAt: input.now,
      })
      .returning({ id: posts.id });
    if (row === undefined) {
      throw new Error('INSERT em posts não devolveu a linha');
    }
    return row.id;
  }

  /** Rascunho de foto ou de reel (5.3): nasce `draft`, sem legenda (ela chega no `publish`). */
  async insertDraft(
    executor: DbExecutor,
    authorId: string,
    type: 'photo' | 'reel',
    now: Date,
  ): Promise<string> {
    const [row] = await executor
      .insert(posts)
      .values({ authorId, type, status: 'draft', createdAt: now })
      .returning({ id: posts.id });
    if (row === undefined) {
      throw new Error('INSERT em posts não devolveu a linha');
    }
    return row.id;
  }

  async insertMedia(executor: DbExecutor, rows: NewPostMediaRow[]): Promise<PostMediaRow[]> {
    return executor.insert(postMedia).values(rows).returning();
  }

  /** Mídia de vários posts, em ordem de posição. */
  async mediaOf(postIds: readonly string[]): Promise<PostMediaRow[]> {
    if (postIds.length === 0) {
      return [];
    }
    return this.db
      .select()
      .from(postMedia)
      .where(inArray(postMedia.postId, [...postIds]))
      .orderBy(asc(postMedia.postId), asc(postMedia.position));
  }

  /** Quais destes posts o leitor curtiu (`likedByMe`, PERM-15: nunca a lista de quem curtiu). */
  async likedBy(userId: string, postIds: readonly string[]): Promise<Set<string>> {
    if (postIds.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .select({ postId: likes.postId })
      .from(likes)
      .where(and(eq(likes.userId, userId), inArray(likes.postId, [...postIds])));
    return new Set(rows.map((row) => row.postId));
  }

  /**
   * `draft` → `processing` com a legenda, numa transação. Devolve `false` se outro `publish`
   * concorrente já mudou o estado (o segundo só lê o resultado: idempotente).
   */
  async markProcessing(
    executor: DbExecutor,
    postId: string,
    caption: string | null,
    now: Date,
  ): Promise<boolean> {
    const updated = await executor
      .update(posts)
      .set({ status: 'processing', caption })
      .where(and(eq(posts.id, postId), eq(posts.status, 'draft')))
      .returning({ id: posts.id });
    if (updated.length === 0) {
      return false;
    }
    await executor
      .update(postMedia)
      .set({ status: 'processing', updatedAt: now })
      .where(eq(postMedia.postId, postId));
    return true;
  }

  /** Desfaz o `publish` quando a fila falhou: o app pode tentar de novo. */
  async revertToDraft(postId: string, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const reverted = await tx
        .update(posts)
        .set({ status: 'draft', caption: null })
        .where(and(eq(posts.id, postId), eq(posts.status, 'processing')))
        .returning({ id: posts.id });
      if (reverted.length > 0) {
        await tx
          .update(postMedia)
          .set({ status: 'pending_upload', updatedAt: now })
          .where(eq(postMedia.postId, postId));
      }
    });
  }

  /** Exclusão do autor: some na hora; os objetos e a linha saem pelo job do worker (2.9). */
  async softDelete(postId: string, authorId: string, now: Date): Promise<boolean> {
    const deleted = await this.db
      .update(posts)
      .set({ deletedAt: now })
      .where(and(eq(posts.id, postId), eq(posts.authorId, authorId), isNull(posts.deletedAt)))
      .returning({ id: posts.id });
    return deleted.length > 0;
  }

  /**
   * Abas do perfil (história 2.6). Para os outros: só publicados, pelo índice
   * `posts_author_type_pub_idx`. Para o dono: também os em processamento e com falha, ordenados por
   * `coalesce(published_at, created_at)` (rascunhos não aparecem).
   */
  async listByAuthor(query: AuthorPostsQuery): Promise<AuthorPostRecord[]> {
    const sortAt: SQL<Date> = query.includePending
      ? sql<Date>`coalesce(${posts.publishedAt}, ${posts.createdAt})`
      : sql<Date>`${posts.publishedAt}`;
    const conditions: SQL[] = [
      sql`${posts.authorId} = ${query.authorId}`,
      sql`${posts.type} = ${query.type}`,
      sql`${posts.deletedAt} is null`,
      query.includePending
        ? sql`${posts.status} in ('processing', 'published', 'failed')`
        : sql`${posts.status} = 'published'`,
    ];
    if (query.after !== undefined) {
      conditions.push(
        sql`(${sortAt}, ${posts.id}) < (${query.after.at.toISOString()}::timestamptz, ${query.after.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select({ ...postRecordColumns, sortAt: sortAt.mapWith(posts.createdAt) })
      .from(posts)
      .innerJoin(users, eq(users.id, posts.authorId))
      .where(and(...conditions))
      .orderBy(sql`${sortAt} desc nulls last`, sql`${posts.id} desc nulls last`)
      .limit(query.limit);
    return rows;
  }
}
