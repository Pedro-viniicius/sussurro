import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '@sussurro/db';
import type { LikeState } from '@sussurro/shared';

import { LikesRepository } from './likes.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PostsService } from '../posts/posts.service.js';

/** Curtir e descurtir (história 2.7). Não existe lista de quem curtiu (PERM-15). */
@Injectable()
export class LikesService {
  constructor(
    private readonly likes: LikesRepository,
    private readonly posts: PostsService,
    private readonly notifications: NotificationsService,
    private readonly clock: Clock,
  ) {}

  /**
   * Post invisível para quem curte → o mesmo 404 do detalhe (PERM-14). (Fase 6) A curtida nova
   * grava a notificação do autor na mesma transação (uma por pessoa e post, NOT-07) e o push sai
   * depois do commit.
   */
  async like(viewer: AuthContext, postId: string): Promise<LikeState> {
    const post = await this.posts.findInteractable(viewer, postId);
    const now = this.clock.now();
    const { likeCount, jobs } = await this.likes.db.transaction(async (tx) => {
      const added = await this.likes.like(tx, post.id, viewer.userId, now);
      const pushJobs = added
        ? await this.notifications.recordLike(tx, {
            postAuthorId: post.authorId,
            actorId: viewer.userId,
            postId: post.id,
            now,
          })
        : [];
      return { likeCount: await this.likes.likeCount(tx, post.id), jobs: pushJobs };
    });
    await this.notifications.dispatch(jobs);
    return { likeCount, likedByMe: true };
  }

  /** Descurtir não apaga a notificação: curtir de novo não gera outra (NOT-07). */
  async unlike(viewer: AuthContext, postId: string): Promise<LikeState> {
    const post = await this.posts.findInteractable(viewer, postId);
    const likeCount = await this.likes.db.transaction(async (tx) => {
      await this.likes.unlike(tx, post.id, viewer.userId);
      return this.likes.likeCount(tx, post.id);
    });
    return { likeCount, likedByMe: false };
  }

  /** Usado pelo `DELETE /me` (A-13, CONTA-03), na mesma transação da exclusão. */
  removeAllByUser(executor: DbExecutor, userId: string): Promise<void> {
    return this.likes.removeAllByUser(executor, userId);
  }
}
