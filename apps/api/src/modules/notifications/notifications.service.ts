import { Injectable, Logger } from '@nestjs/common';
import type { DbExecutor } from '@sussurro/db';
import {
  followersBucketKey,
  type Notification,
  type NotificationActor,
  notificationExcerpt,
  NOTIFICATIONS_LIST_DAYS,
  type NotificationsPage,
  type NotificationsQuery,
  type PushJobMessage,
  UNREAD_COUNT_MAX,
  type UnreadNotifications,
} from '@sussurro/shared';
import { z } from 'zod';

import {
  type NotificationRecord,
  NotificationsRepository,
  type NotificationVisibility,
} from './notifications.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { CursorCodec, invalidCursor } from '../../common/http/cursor.js';
import { PushQueue } from '../../infra/storage/push-queue.js';
import { MediaService } from '../media/media.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Cursor da lista: conta (o cursor de uma pessoa não vale para outra), `updated_at` (ms) e id. */
const NotificationsCursorSchema = z.object({
  u: z.uuid(),
  a: z.int().nonnegative(),
  i: z.uuid(),
});
const NOTIFICATIONS_CURSOR = 'notifications';

function job(notificationId: string): PushJobMessage {
  return { type: 'notification', notificationId };
}

/**
 * Notificações no app e o enfileiramento do push (ADR 0011; histórias 6.1, 6.2, 6.3, 6.5 e 6.6).
 *
 * Escrita: os `record*` rodam **na transação do evento** (curtida, comentário, conexão, follow) e
 * devolvem as mensagens de push; quem chama as entrega com `dispatch` **depois do commit** (o push é
 * best-effort: a fila fora do ar não desfaz a notificação, só fica no log).
 *
 * Leitura: só as notificações de quem chama, dos últimos 30 dias, sem o que ele não pode mais ver
 * (conta ou post apagado, bloqueio, post de conta que deixou de ser conexão; NOT-09, X.2).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly policy: AccessPolicyService,
    private readonly media: MediaService,
    private readonly cursors: CursorCodec,
    private readonly queue: PushQueue,
    private readonly clock: Clock,
  ) {}

  // --- escrita (na transação do evento) ----------------------------------------------------------

  /** Curtida (6.1 CA2, NOT-07): uma por pessoa e post; a própria curtida não gera nada. */
  async recordLike(
    executor: DbExecutor,
    input: { postAuthorId: string; actorId: string; postId: string; now: Date },
  ): Promise<PushJobMessage[]> {
    if (input.postAuthorId === input.actorId) {
      return [];
    }
    const id = await this.notifications.insertLike(executor, {
      recipientId: input.postAuthorId,
      actorId: input.actorId,
      postId: input.postId,
      now: input.now,
    });
    return id === undefined ? [] : [job(id)];
  }

  /**
   * Comentário ou resposta (6.1 CA1): quem respondeu avisa o autor do comentário respondido
   * (`comment_replied`); o autor do post recebe `post_commented`, a menos que seja quem comentou ou
   * o autor do comentário respondido (que já recebeu a resposta).
   */
  async recordComment(
    executor: DbExecutor,
    input: {
      postAuthorId: string;
      actorId: string;
      postId: string;
      commentId: string;
      parentAuthorId: string | null;
      now: Date;
    },
  ): Promise<PushJobMessage[]> {
    const jobs: PushJobMessage[] = [];
    const base = {
      actorId: input.actorId,
      postId: input.postId,
      commentId: input.commentId,
      now: input.now,
    };
    if (input.parentAuthorId !== null && input.parentAuthorId !== input.actorId) {
      jobs.push(
        job(
          await this.notifications.insertComment(executor, {
            ...base,
            recipientId: input.parentAuthorId,
            type: 'comment_replied',
          }),
        ),
      );
    }
    if (input.postAuthorId !== input.actorId && input.postAuthorId !== input.parentAuthorId) {
      jobs.push(
        job(
          await this.notifications.insertComment(executor, {
            ...base,
            recipientId: input.postAuthorId,
            type: 'post_commented',
          }),
        ),
      );
    }
    return jobs;
  }

  /**
   * Conexão criada (PROX-29): uma notificação para cada pessoa. O push vai só para `pushTo`, a
   * pessoa que não fez a última ação (quem aceitou já está com a tela aberta).
   */
  async recordConnection(
    executor: DbExecutor,
    input: { first: string; second: string; pushTo: string; now: Date },
  ): Promise<PushJobMessage[]> {
    const jobs: PushJobMessage[] = [];
    for (const [recipientId, actorId] of [
      [input.first, input.second],
      [input.second, input.first],
    ] as const) {
      const id = await this.notifications.insertConnection(executor, {
        recipientId,
        actorId,
        now: input.now,
      });
      if (recipientId === input.pushTo) {
        jobs.push(job(id));
      }
    }
    return jobs;
  }

  /**
   * Novo seguidor (6.3, ADR 0011): soma 1 na linha do dia (America/Sao_Paulo) e a deixa não lida
   * (NOT-06). Nada de quem seguiu é gravado nem enviado. O push sai quando a linha é nova ou
   * estava lida: seguidores em sequência, antes de o criador abrir as notificações, não repetem.
   */
  async recordNewFollower(
    executor: DbExecutor,
    input: { creatorId: string; now: Date },
  ): Promise<PushJobMessage[]> {
    const result = await this.notifications.upsertFollowers(executor, {
      recipientId: input.creatorId,
      bucketKey: followersBucketKey(input.now),
      now: input.now,
    });
    return result.becameUnread ? [job(result.id)] : [];
  }

  /** Bloqueio (X.2), na transação do bloqueio: as notificações entre os dois somem. */
  removeBetween(executor: DbExecutor, first: string, second: string): Promise<void> {
    return this.notifications.removeBetween(executor, first, second);
  }

  /** Desfazer conexão (D8), na mesma transação. */
  removeConnection(executor: DbExecutor, first: string, second: string): Promise<void> {
    return this.notifications.removeConnectionBetween(executor, first, second);
  }

  /** Exclusão de conta (`DELETE /me`), na mesma transação. */
  removeAllInvolving(executor: DbExecutor, userId: string): Promise<void> {
    return this.notifications.removeAllInvolving(executor, userId);
  }

  // --- push (depois do commit) -------------------------------------------------------------------

  /**
   * Entrega as mensagens à fila `push` (ADR 0011). Falha da fila não derruba a requisição nem
   * desfaz a notificação (6.5 CA4): fica só no log.
   */
  async dispatch(jobs: readonly PushJobMessage[]): Promise<void> {
    if (jobs.length === 0) {
      return;
    }
    try {
      await this.queue.send(jobs);
    } catch (error) {
      this.logger.warn(
        `Push não enfileirado (${String(jobs.length)} mensagem(ns)): ${describeError(error)}`,
      );
    }
  }

  /** Pedido de conexão novo (6.6): push para quem recebeu, que abre o Conectar. */
  notifyConnectionRequest(requestId: string): Promise<void> {
    return this.dispatch([{ type: 'connection-request', requestId }]);
  }

  // --- leitura -----------------------------------------------------------------------------------

  private visibility(viewer: AuthContext): NotificationVisibility {
    return {
      notBlocked: (column) => this.policy.hideBlockedFor(viewer, column),
      profileVisible: (id, type) => this.policy.profileVisibleFilter(viewer, id, type),
      connected: (column) => this.policy.connectedFilter(viewer, column),
    };
  }

  private since(): Date {
    return new Date(this.clock.now().getTime() - NOTIFICATIONS_LIST_DAYS * DAY_MS);
  }

  /** `GET /notifications` (6.1): página das notificações de quem chama. */
  async list(viewer: AuthContext, query: NotificationsQuery): Promise<NotificationsPage> {
    let after: { at: Date; id: string } | undefined;
    if (query.cursor !== undefined) {
      const cursor = this.cursors.decode(
        NOTIFICATIONS_CURSOR,
        query.cursor,
        NotificationsCursorSchema,
      );
      if (cursor.u !== viewer.userId) {
        throw invalidCursor();
      }
      after = { at: new Date(cursor.a), id: cursor.i };
    }
    const rows = await this.notifications.page({
      recipientId: viewer.userId,
      since: this.since(),
      rules: this.visibility(viewer),
      after,
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? this.cursors.encode(NOTIFICATIONS_CURSOR, {
            u: viewer.userId,
            a: last.updatedAt.getTime(),
            i: last.id,
          })
        : null;
    return { items: await this.toViews(viewer, page), nextCursor };
  }

  /** `GET /notifications/unread-count` (6.2): quantas não lidas (até 99). */
  async unreadCount(viewer: AuthContext): Promise<UnreadNotifications> {
    const count = await this.notifications.unreadCount({
      recipientId: viewer.userId,
      since: this.since(),
      rules: this.visibility(viewer),
      cap: UNREAD_COUNT_MAX,
    });
    return { count };
  }

  /**
   * `POST /notifications/read {upTo}` (6.2): lidas até `upTo` (no máximo agora). Devolve quantas
   * ainda estão não lidas (seguidores que chegaram depois de `upTo`, NOT-06).
   */
  async markRead(viewer: AuthContext, upTo: string): Promise<UnreadNotifications> {
    const now = this.clock.now();
    const limit = new Date(Math.min(new Date(upTo).getTime(), now.getTime()));
    await this.notifications.markRead(viewer.userId, limit, now);
    return this.unreadCount(viewer);
  }

  private async toViews(
    viewer: AuthContext,
    records: readonly NotificationRecord[],
  ): Promise<Notification[]> {
    const visibleActors = await this.policy.visibleProfiles(
      viewer,
      records.flatMap((record) =>
        record.actorId === null || record.actorType === null
          ? []
          : [{ id: record.actorId, accountType: record.actorType }],
      ),
    );
    const views = await Promise.all(records.map((record) => this.toView(record, visibleActors)));
    return views.filter((view): view is Notification => view !== null);
  }

  /** Visão de uma notificação; `null` se faltar algo que o tipo exige (linha incoerente). */
  private async toView(
    record: NotificationRecord,
    visibleActors: ReadonlySet<string>,
  ): Promise<Notification | null> {
    const base = {
      id: record.id,
      read: record.readAt !== null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
    if (record.type === 'new_followers') {
      // NOT-02: só o número. A linha nem tem quem seguiu (CHECK do banco).
      return { ...base, type: 'new_followers', count: record.count };
    }
    const actor = await this.actorView(record, visibleActors);
    if (actor === null) {
      return null;
    }
    if (record.type === 'connection_created') {
      return { ...base, type: 'connection_created', actor };
    }
    if (record.postId === null || record.postType === null) {
      return null;
    }
    const post = {
      id: record.postId,
      type: record.postType,
      thumbUrl: record.postType === 'text' ? null : await this.media.signUrl(record.postThumbKey),
    };
    if (record.type === 'post_liked') {
      return { ...base, type: 'post_liked', actor, post };
    }
    if (record.commentBody === null) {
      return null;
    }
    return {
      ...base,
      type: record.type,
      actor,
      post,
      excerpt: notificationExcerpt(record.commentBody),
    };
  }

  private async actorView(
    record: NotificationRecord,
    visibleActors: ReadonlySet<string>,
  ): Promise<NotificationActor | null> {
    if (
      record.actorId === null ||
      record.actorHandle === null ||
      record.actorName === null ||
      record.actorType === null
    ) {
      return null;
    }
    return {
      handle: record.actorHandle,
      name: record.actorName,
      avatarUrl: await this.media.signUrl(record.actorAvatarKey),
      accountType: record.actorType,
      profileVisible: visibleActors.has(record.actorId),
    };
  }
}
