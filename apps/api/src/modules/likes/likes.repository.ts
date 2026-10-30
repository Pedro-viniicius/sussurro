import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  type Database,
  type DbExecutor,
  type DbHandle,
  eq,
  likes,
  posts,
  sql,
} from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

/**
 * Curtidas com o contador desnormalizado na mesma transação (ADR 0004, CNT-04). Idempotentes: o
 * contador só muda quando a linha de `likes` foi de fato criada ou apagada. (Fase 6) A transação é
 * do service, que grava a notificação nela (ADR 0011).
 */
@Injectable()
export class LikesRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  async likeCount(executor: DbExecutor, postId: string): Promise<number> {
    const [row] = await executor
      .select({ likeCount: posts.likeCount })
      .from(posts)
      .where(eq(posts.id, postId));
    return row?.likeCount ?? 0;
  }

  /** Curte; `true` se a curtida é nova (o contador subiu). */
  async like(executor: DbExecutor, postId: string, userId: string, now: Date): Promise<boolean> {
    const inserted = await executor
      .insert(likes)
      .values({ postId, userId, createdAt: now })
      .onConflictDoNothing()
      .returning({ postId: likes.postId });
    if (inserted.length === 0) {
      return false;
    }
    await executor
      .update(posts)
      .set({ likeCount: sql`${posts.likeCount} + 1` })
      .where(eq(posts.id, postId));
    return true;
  }

  /** Descurte; idempotente. */
  async unlike(executor: DbExecutor, postId: string, userId: string): Promise<void> {
    const removed = await executor
      .delete(likes)
      .where(and(eq(likes.postId, postId), eq(likes.userId, userId)))
      .returning({ postId: likes.postId });
    if (removed.length > 0) {
      await executor
        .update(posts)
        .set({ likeCount: sql`${posts.likeCount} - 1` })
        .where(eq(posts.id, postId));
    }
  }

  /**
   * Exclusão de conta (A-13, CONTA-03): as curtidas da pessoa somem na hora e os contadores dos
   * posts caem na mesma transação do `DELETE /me`.
   */
  async removeAllByUser(executor: DbExecutor, userId: string): Promise<void> {
    await executor.execute(sql`
      with removed as (
        delete from likes where user_id = ${userId} returning post_id
      ), per_post as (
        select post_id, count(*)::int as total from removed group by post_id
      )
      update posts p
         set like_count = greatest(p.like_count - per_post.total, 0)
        from per_post
       where p.id = per_post.post_id
    `);
  }
}
