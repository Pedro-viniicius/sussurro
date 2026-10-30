import { Injectable } from '@nestjs/common';
import { comments, type DbExecutor } from '@sussurro/db';
import {
  type Comment,
  type CommentsPage,
  type CommentsQuery,
  type CommentThread,
  type CreateCommentRequest,
  ErrorCode,
} from '@sussurro/shared';
import { z } from 'zod';

import { type CommentRecord, CommentsRepository } from './comments.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { CursorCodec, invalidCursor } from '../../common/http/cursor.js';
import { MediaService } from '../media/media.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';
import type { PostRecord } from '../posts/posts.repository.js';
import { PostsService } from '../posts/posts.service.js';

const commentNotFound = () =>
  new DomainError(ErrorCode.NOT_FOUND, 404, 'Comentário não encontrado');

const idSchema = z.uuid();

/** Visão já montada de um comentário (sempre existe: vem da mesma lista). */
function viewOf(views: Map<string, Comment>, id: string): Comment {
  const view = views.get(id);
  if (view === undefined) {
    throw new Error(`Comentário ${id} sem visão montada`);
  }
  return view;
}

/** Cursor da lista de comentários: post, `created_at` (ms) e id do último de primeiro nível. */
const CommentsCursorSchema = z.object({
  p: z.uuid(),
  a: z.int().nonnegative(),
  i: z.uuid(),
});
const COMMENTS_CURSOR = 'comments';

/**
 * Comentários, respostas (1 nível) e exclusão (história 2.8, D11, A-06):
 * - visíveis a quem vê o post; o @ só é tocável com `profileVisible` (PERM-10c);
 * - post que o leitor não vê → o mesmo 404 do detalhe (PERM-14);
 * - criador: só responde (com `parentId`) nos próprios posts; comentário de primeiro nível do
 *   criador e qualquer comentário dele em post de outra conta → 403 `ACCOUNT_TYPE_NOT_ALLOWED`;
 * - apaga o autor do comentário ou o autor do post; apagar um comentário apaga as respostas.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly comments: CommentsRepository,
    private readonly posts: PostsService,
    private readonly policy: AccessPolicyService,
    private readonly media: MediaService,
    private readonly cursors: CursorCodec,
    private readonly notifications: NotificationsService,
    private readonly clock: Clock,
  ) {}

  async list(viewer: AuthContext, postId: string, query: CommentsQuery): Promise<CommentsPage> {
    const post = await this.posts.findInteractable(viewer, postId);
    let after: { at: Date; id: string } | undefined;
    if (query.cursor !== undefined) {
      const cursor = this.cursors.decode(COMMENTS_CURSOR, query.cursor, CommentsCursorSchema);
      if (cursor.p !== post.id) {
        throw invalidCursor();
      }
      after = { at: new Date(cursor.a), id: cursor.i };
    }
    // X.2: comentários e respostas de quem tem bloqueio com o leitor não aparecem para ele.
    const visible = this.policy.hideBlockedFor(viewer, comments.authorId);
    const rows = await this.comments.topLevelPage(post.id, after, query.limit + 1, visible);
    const page = rows.slice(0, query.limit);
    const replies = await this.comments.repliesOf(
      page.map((row) => row.id),
      visible,
    );
    const views = await this.toComments(viewer, post, [...page, ...replies]);

    const items: CommentThread[] = page.map((row) => ({
      ...viewOf(views, row.id),
      replies: replies
        .filter((reply) => reply.parentId === row.id)
        .map((reply) => viewOf(views, reply.id)),
    }));
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? this.cursors.encode(COMMENTS_CURSOR, {
            p: post.id,
            a: last.createdAt.getTime(),
            i: last.id,
          })
        : null;
    return { items, nextCursor };
  }

  async create(viewer: AuthContext, postId: string, input: CreateCommentRequest): Promise<Comment> {
    // Primeiro a visibilidade (404 igual ao de inexistente), depois a regra do criador (A-06).
    const post = await this.posts.findInteractable(viewer, postId);
    if (
      viewer.accountType === 'creator' &&
      (post.authorId !== viewer.userId || input.parentId === undefined)
    ) {
      throw new DomainError(
        ErrorCode.ACCOUNT_TYPE_NOT_ALLOWED,
        403,
        'Criador só responde a comentários nos próprios posts',
      );
    }
    // Responder a um comentário escondido pelo bloqueio (X.2) = responder a um inexistente. A
    // consulta fica fora da transação: dentro dela, só o que roda no `tx`.
    if (input.parentId !== undefined) {
      const parent = idSchema.safeParse(input.parentId).success
        ? await this.comments.findRecord(input.parentId)
        : undefined;
      if (parent !== undefined && (await this.isHiddenAuthor(viewer, parent.authorId))) {
        throw commentNotFound();
      }
    }
    const now = this.clock.now();
    const { id, jobs } = await this.comments.db.transaction(async (tx) => {
      let parentAuthorId: string | null = null;
      if (input.parentId !== undefined) {
        const parent = await this.comments.lockParent(tx, input.parentId, post.id);
        if (parent === undefined) {
          throw commentNotFound();
        }
        if (parent.parentId !== null) {
          throw new DomainError(ErrorCode.VALIDATION_ERROR, 400, 'Entrada inválida', [
            { path: 'parentId', message: 'Só é possível responder a um comentário (1 nível).' },
          ]);
        }
        parentAuthorId = parent.authorId;
      }
      const commentId = await this.comments.insert(tx, {
        postId: post.id,
        authorId: viewer.userId,
        parentId: input.parentId ?? null,
        body: input.body,
        now,
      });
      // Fase 6 (ADR 0011): a notificação na mesma transação; o push depois do commit.
      const pushJobs = await this.notifications.recordComment(tx, {
        postAuthorId: post.authorId,
        actorId: viewer.userId,
        postId: post.id,
        commentId,
        parentAuthorId,
        now,
      });
      return { id: commentId, jobs: pushJobs };
    });
    await this.notifications.dispatch(jobs);
    const record = await this.comments.findRecord(id);
    if (record === undefined) {
      throw commentNotFound();
    }
    const views = await this.toComments(viewer, post, [record]);
    return viewOf(views, id);
  }

  /**
   * `DELETE /comments/:id`: o autor do comentário ou do post. Outra pessoa que vê o post recebe 403;
   * quem nem vê o post recebe o 404 de inexistente.
   */
  async delete(viewer: AuthContext, commentId: string): Promise<void> {
    const comment = idSchema.safeParse(commentId).success
      ? await this.comments.findWithPost(commentId)
      : undefined;
    if (comment === undefined) {
      throw commentNotFound();
    }
    const allowed = comment.authorId === viewer.userId || comment.postAuthorId === viewer.userId;
    if (!allowed && (await this.isHiddenAuthor(viewer, comment.authorId))) {
      throw commentNotFound();
    }
    if (!allowed) {
      const visible = await this.policy.canViewPost(viewer, {
        authorId: comment.postAuthorId,
        authorType: comment.postAuthorType,
        status: comment.postStatus,
        deletedAt: null,
        authorDeletedAt: null,
      });
      throw visible
        ? new DomainError(ErrorCode.FORBIDDEN, 403, 'Só o autor do comentário ou do post apaga')
        : commentNotFound();
    }
    await this.comments.softDeleteWithReplies(comment.id, comment.postId, this.clock.now());
  }

  /** Usado pelo `DELETE /me` (A-13, CONTA-03), na mesma transação da exclusão. */
  removeAllByUser(executor: DbExecutor, userId: string, now: Date): Promise<void> {
    return this.comments.removeAllByUser(executor, userId, now);
  }

  /** Usado pelo bloqueio (X.2), na mesma transação: os comentários de cada um nos posts do outro. */
  removeBetween(executor: DbExecutor, first: string, second: string, now: Date): Promise<void> {
    return this.comments.removeBetween(executor, first, second, now);
  }

  /**
   * Autor de um comentário que o leitor vê (bloquear ou denunciar a partir do comentário, X.1 e
   * X.2): o comentário está vivo, o post é visível para o leitor (`AccessPolicyService`) e o autor
   * não tem bloqueio com ele. Qualquer outro caso → `undefined` (quem chama responde como
   * inexistente). O leitor já viu o @ do autor no comentário (D11): nada novo é revelado.
   */
  async findVisibleComment(
    viewer: AuthContext,
    commentId: string,
  ): Promise<{ id: string; authorId: string; authorHandle: string; postId: string } | undefined> {
    const comment = idSchema.safeParse(commentId).success
      ? await this.comments.findWithPost(commentId)
      : undefined;
    if (comment === undefined) {
      return undefined;
    }
    const postVisible = await this.policy.canViewPost(viewer, {
      authorId: comment.postAuthorId,
      authorType: comment.postAuthorType,
      status: comment.postStatus,
      deletedAt: null,
      authorDeletedAt: null,
    });
    if (!postVisible || (await this.isHiddenAuthor(viewer, comment.authorId))) {
      return undefined;
    }
    return {
      id: comment.id,
      authorId: comment.authorId,
      authorHandle: comment.authorHandle,
      postId: comment.postId,
    };
  }

  /** O autor tem bloqueio com o leitor (X.2): os comentários dele não existem para o leitor. */
  private async isHiddenAuthor(viewer: AuthContext, authorId: string): Promise<boolean> {
    if (authorId === viewer.userId) {
      return false;
    }
    return (await this.policy.blockedAmong(viewer, [authorId])).has(authorId);
  }

  /** Visão de cada comentário para este leitor, com `profileVisible` calculado em lote. */
  private async toComments(
    viewer: AuthContext,
    post: PostRecord,
    records: readonly CommentRecord[],
  ): Promise<Map<string, Comment>> {
    const visible = await this.policy.visibleProfiles(
      viewer,
      records.map((record) => ({ id: record.authorId, accountType: record.authorType })),
    );
    const views = await Promise.all(
      records.map(async (record): Promise<Comment> => ({
        id: record.id,
        parentId: record.parentId,
        body: record.body,
        createdAt: record.createdAt.toISOString(),
        author: {
          handle: record.authorHandle,
          name: record.authorName,
          avatarUrl: await this.media.signUrl(record.authorAvatarKey),
          accountType: record.authorType,
          profileVisible: visible.has(record.authorId),
        },
        canDelete: record.authorId === viewer.userId || post.authorId === viewer.userId,
      })),
    );
    return new Map(views.map((view) => [view.id, view]));
  }
}
