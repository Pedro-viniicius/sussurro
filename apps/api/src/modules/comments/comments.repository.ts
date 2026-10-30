import { Inject, Injectable } from '@nestjs/common';
import {
  alias,
  and,
  asc,
  comments,
  type Database,
  type DbExecutor,
  type DbHandle,
  eq,
  inArray,
  isNull,
  posts,
  type SQL,
  sql,
  users,
} from '@sussurro/db';
import type { AccountType, PostStatus } from '@sussurro/shared';

import { DATABASE } from '../../infra/database/database.providers.js';
import type { PageAnchor } from '../posts/posts.repository.js';

/** Comentário vivo com o autor (contas excluídas nunca aparecem, A-11/A-13). */
export interface CommentRecord {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  createdAt: Date;
  authorId: string;
  authorHandle: string;
  authorName: string;
  authorAvatarKey: string | null;
  authorType: AccountType;
}

const commentColumns = {
  id: comments.id,
  postId: comments.postId,
  parentId: comments.parentId,
  body: comments.body,
  createdAt: comments.createdAt,
  authorId: comments.authorId,
  authorHandle: users.handle,
  authorName: users.name,
  authorAvatarKey: users.avatarKey,
  authorType: users.accountType,
};

/** Comentário com o post e o autor do post, para decidir quem pode apagar. */
export interface CommentWithPost {
  id: string;
  parentId: string | null;
  authorId: string;
  authorHandle: string;
  postId: string;
  postAuthorId: string;
  postAuthorType: AccountType;
  postStatus: PostStatus;
}

const liveComment = and(isNull(comments.deletedAt), isNull(users.deletedAt));

/** Autor do post, numa segunda junção com `users`. */
const postAuthor = alias(users, 'post_author');

@Injectable()
export class CommentsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  /**
   * Comentários de primeiro nível, do mais antigo para o mais novo (a página conta só eles).
   * `visible`: condição da política (X.2: sem os autores com bloqueio com o leitor), aplicada no
   * banco para a paginação continuar exata.
   */
  async topLevelPage(
    postId: string,
    after: PageAnchor | undefined,
    limit: number,
    visible: SQL,
  ): Promise<CommentRecord[]> {
    const conditions: (SQL | undefined)[] = [
      eq(comments.postId, postId),
      isNull(comments.parentId),
      liveComment,
      visible,
    ];
    if (after !== undefined) {
      conditions.push(
        sql`(${comments.createdAt}, ${comments.id}) > (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`,
      );
    }
    return this.db
      .select(commentColumns)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(and(...conditions))
      .orderBy(asc(comments.createdAt), asc(comments.id))
      .limit(limit);
  }

  /** Respostas (1 nível) dos comentários da página, em ordem cronológica (com o mesmo filtro). */
  async repliesOf(parentIds: readonly string[], visible: SQL): Promise<CommentRecord[]> {
    if (parentIds.length === 0) {
      return [];
    }
    return this.db
      .select(commentColumns)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(and(inArray(comments.parentId, [...parentIds]), liveComment, visible))
      .orderBy(asc(comments.createdAt), asc(comments.id));
  }

  async findRecord(id: string, executor: DbExecutor = this.db): Promise<CommentRecord | undefined> {
    const [row] = await executor
      .select(commentColumns)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.id, id), liveComment))
      .limit(1);
    return row;
  }

  /** Comentário vivo num post vivo (de conta ativa), com o autor do post. */
  async findWithPost(id: string): Promise<CommentWithPost | undefined> {
    const [row] = await this.db
      .select({
        id: comments.id,
        parentId: comments.parentId,
        authorId: comments.authorId,
        authorHandle: users.handle,
        postId: posts.id,
        postAuthorId: posts.authorId,
        postAuthorType: postAuthor.accountType,
        postStatus: posts.status,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .innerJoin(posts, eq(posts.id, comments.postId))
      .innerJoin(postAuthor, eq(postAuthor.id, posts.authorId))
      .where(
        and(
          eq(comments.id, id),
          liveComment,
          isNull(posts.deletedAt),
          isNull(postAuthor.deletedAt),
        ),
      )
      .limit(1);
    return row;
  }

  /** Pai de uma resposta, travado até o fim da transação (não some no meio). */
  async lockParent(
    executor: DbExecutor,
    parentId: string,
    postId: string,
  ): Promise<{ id: string; parentId: string | null; authorId: string } | undefined> {
    const [row] = await executor
      .select({ id: comments.id, parentId: comments.parentId, authorId: comments.authorId })
      .from(comments)
      .where(
        and(eq(comments.id, parentId), eq(comments.postId, postId), isNull(comments.deletedAt)),
      )
      .for('share');
    return row;
  }

  /** Grava o comentário e soma 1 em `comment_count`, na mesma transação (ADR 0004). */
  async insert(
    executor: DbExecutor,
    input: { postId: string; authorId: string; parentId: string | null; body: string; now: Date },
  ): Promise<string> {
    const [row] = await executor
      .insert(comments)
      .values({
        postId: input.postId,
        authorId: input.authorId,
        parentId: input.parentId,
        body: input.body,
        createdAt: input.now,
      })
      .returning({ id: comments.id });
    if (row === undefined) {
      throw new Error('INSERT em comments não devolveu a linha');
    }
    await executor
      .update(posts)
      .set({ commentCount: sql`${posts.commentCount} + 1` })
      .where(eq(posts.id, input.postId));
    return row.id;
  }

  /**
   * Apaga o comentário e as respostas dele (`deleted_at`) e desconta todos de `comment_count`, na
   * mesma transação.
   */
  async softDeleteWithReplies(commentId: string, postId: string, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .update(comments)
        .set({ deletedAt: now })
        .where(
          and(
            sql`(${comments.id} = ${commentId} or ${comments.parentId} = ${commentId})`,
            isNull(comments.deletedAt),
          ),
        )
        .returning({ id: comments.id });
      if (removed.length > 0) {
        await tx
          .update(posts)
          .set({ commentCount: sql`greatest(${posts.commentCount} - ${removed.length}, 0)` })
          .where(eq(posts.id, postId));
      }
    });
  }

  /**
   * Exclusão de conta (A-13, CONTA-03): os comentários da pessoa (e as respostas a eles) somem na
   * hora e os contadores dos posts caem, na transação do `DELETE /me`.
   */
  async removeAllByUser(executor: DbExecutor, userId: string, now: Date): Promise<void> {
    await executor.execute(sql`
      with target as (
        select id from comments where author_id = ${userId} and deleted_at is null
      ), removed as (
        update comments c
           set deleted_at = ${now.toISOString()}::timestamptz
         where c.deleted_at is null
           and (c.id in (select id from target) or c.parent_id in (select id from target))
        returning c.post_id
      ), per_post as (
        select post_id, count(*)::int as total from removed group by post_id
      )
      update posts p
         set comment_count = greatest(p.comment_count - per_post.total, 0)
        from per_post
       where p.id = per_post.post_id
    `);
  }

  /**
   * Bloqueio (X.2): apaga os comentários de cada uma das duas contas nos posts da outra (e as
   * respostas a eles), com os contadores ajustados, na transação do bloqueio. Depois do bloqueio
   * nenhuma das duas fica com comentário no conteúdo da outra, que ela não poderia mais ver nem
   * apagar.
   */
  async removeBetween(
    executor: DbExecutor,
    first: string,
    second: string,
    now: Date,
  ): Promise<void> {
    await executor.execute(sql`
      with target as (
        select c.id from comments c join posts p on p.id = c.post_id
         where c.deleted_at is null
           and ((c.author_id = ${first} and p.author_id = ${second})
             or (c.author_id = ${second} and p.author_id = ${first}))
      ), removed as (
        update comments c
           set deleted_at = ${now.toISOString()}::timestamptz
         where c.deleted_at is null
           and (c.id in (select id from target) or c.parent_id in (select id from target))
        returning c.post_id
      ), per_post as (
        select post_id, count(*)::int as total from removed group by post_id
      )
      update posts p
         set comment_count = greatest(p.comment_count - per_post.total, 0)
        from per_post
       where p.id = per_post.post_id
    `);
  }
}
