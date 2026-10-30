import { Inject, Injectable } from '@nestjs/common';
import {
  alias,
  and,
  comments,
  type Database,
  type DbExecutor,
  type DbHandle,
  desc,
  eq,
  gte,
  isNull,
  lt,
  lte,
  notifications,
  or,
  posts,
  type SQL,
  sql,
  users,
} from '@sussurro/db';
import type { AccountType, NotificationType, PostType } from '@sussurro/shared';

import { rowsOf } from '../../common/db/rows.js';
import { DATABASE } from '../../infra/database/database.providers.js';

/** Notificação com o que a resposta precisa (quem agiu, o post e o comentário). */
export interface NotificationRecord {
  id: string;
  type: NotificationType;
  count: number;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  actorId: string | null;
  actorHandle: string | null;
  actorName: string | null;
  actorAvatarKey: string | null;
  actorType: AccountType | null;
  postId: string | null;
  postType: PostType | null;
  /** Miniatura: a primeira foto pronta ou o poster do reel. */
  postThumbKey: string | null;
  commentBody: string | null;
}

/**
 * Filtros de visibilidade do leitor (vindos do `AccessPolicyService`), aplicados no banco para a
 * paginação não perder itens.
 */
export interface NotificationVisibility {
  notBlocked: (accountColumn: SQL | { getSQL(): SQL }) => SQL;
  profileVisible: (idColumn: SQL | { getSQL(): SQL }, typeColumn: SQL | { getSQL(): SQL }) => SQL;
  connected: (accountColumn: SQL | { getSQL(): SQL }) => SQL;
}

export interface PageAnchor {
  at: Date;
  id: string;
}

const actor = alias(users, 'actor');
const postAuthor = alias(users, 'post_author');

/**
 * Notificações (ADR 0011). As escritas recebem a transação do evento (curtida, comentário,
 * conexão, follow); as leituras escondem o que o leitor não pode mais ver (NOT-09, X.2).
 */
@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  /** Curtida (NOT-07): uma por (quem recebe, quem curtiu, post). `undefined` = já existia. */
  async insertLike(
    executor: DbExecutor,
    input: { recipientId: string; actorId: string; postId: string; now: Date },
  ): Promise<string | undefined> {
    const [row] = await executor
      .insert(notifications)
      .values({
        recipientId: input.recipientId,
        type: 'post_liked',
        actorId: input.actorId,
        postId: input.postId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [notifications.recipientId, notifications.actorId, notifications.postId],
        where: sql`type = 'post_liked'`,
      })
      .returning({ id: notifications.id });
    return row?.id;
  }

  /** Comentário no post (`post_commented`) ou resposta a um comentário (`comment_replied`). */
  async insertComment(
    executor: DbExecutor,
    input: {
      recipientId: string;
      type: 'post_commented' | 'comment_replied';
      actorId: string;
      postId: string;
      commentId: string;
      now: Date;
    },
  ): Promise<string> {
    const [row] = await executor
      .insert(notifications)
      .values({
        recipientId: input.recipientId,
        type: input.type,
        actorId: input.actorId,
        postId: input.postId,
        commentId: input.commentId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: notifications.id });
    if (row === undefined) {
      throw new Error('insertComment: o INSERT não devolveu a linha');
    }
    return row.id;
  }

  /** Conexão criada (PROX-29): uma linha para quem recebe, com a outra pessoa como ator. */
  async insertConnection(
    executor: DbExecutor,
    input: { recipientId: string; actorId: string; now: Date },
  ): Promise<string> {
    const [row] = await executor
      .insert(notifications)
      .values({
        recipientId: input.recipientId,
        type: 'connection_created',
        actorId: input.actorId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: notifications.id });
    if (row === undefined) {
      throw new Error('insertConnection: o INSERT não devolveu a linha');
    }
    return row.id;
  }

  /**
   * Seguidores (6.3, ADR 0011): upsert no dia (`bucketKey`) com `count + 1`, `read_at` nulo e
   * `updated_at` agora. Nenhum dado de quem seguiu entra (o CHECK do banco garante). `becameUnread`:
   * a linha é nova ou estava lida (é quando vale um push; seguidores em sequência não repetem).
   * O `RETURNING old.*` é do Postgres 18.
   */
  async upsertFollowers(
    executor: DbExecutor,
    input: { recipientId: string; bucketKey: string; now: Date },
  ): Promise<{ id: string; count: number; becameUnread: boolean }> {
    const result = await executor.execute(sql`
      insert into notifications (recipient_id, type, count, bucket_key, created_at, updated_at)
      values (${input.recipientId}::uuid, 'new_followers', 1, ${input.bucketKey},
              ${input.now.toISOString()}::timestamptz, ${input.now.toISOString()}::timestamptz)
      on conflict (recipient_id, bucket_key) where bucket_key is not null
      do update set count = notifications.count + 1,
                    read_at = null,
                    updated_at = excluded.updated_at
      returning new.id as id, new.count as count,
                (old.id is null or old.read_at is not null) as "becameUnread"`);
    const [row] = rowsOf<{ id: string; count: number; becameUnread: boolean }>(result);
    if (row === undefined) {
      throw new Error('upsertFollowers: o upsert não devolveu a linha');
    }
    return row;
  }

  /** Bloqueio (X.2): as notificações entre as duas contas somem, nos dois sentidos. */
  async removeBetween(executor: DbExecutor, first: string, second: string): Promise<void> {
    await executor
      .delete(notifications)
      .where(
        or(
          and(eq(notifications.recipientId, first), eq(notifications.actorId, second)),
          and(eq(notifications.recipientId, second), eq(notifications.actorId, first)),
        ),
      );
  }

  /** Desfazer conexão (D8): a notificação "Vocês estão conectados" sai para os dois. */
  async removeConnectionBetween(
    executor: DbExecutor,
    first: string,
    second: string,
  ): Promise<void> {
    await executor
      .delete(notifications)
      .where(
        and(
          eq(notifications.type, 'connection_created'),
          or(
            and(eq(notifications.recipientId, first), eq(notifications.actorId, second)),
            and(eq(notifications.recipientId, second), eq(notifications.actorId, first)),
          ),
        ),
      );
  }

  /** Exclusão de conta: as notificações da pessoa e as em que ela é o ator saem na hora. */
  async removeAllInvolving(executor: DbExecutor, userId: string): Promise<void> {
    await executor
      .delete(notifications)
      .where(or(eq(notifications.recipientId, userId), eq(notifications.actorId, userId)));
  }

  /**
   * Condições de visibilidade para o leitor (dono das notificações):
   * - quem agiu está ativo e sem bloqueio com o leitor (X.2, NOT-09);
   * - o post está publicado, não foi apagado, o autor está ativo e o leitor ainda o vê;
   * - o comentário não foi apagado;
   * - "Vocês estão conectados" só enquanto são conexão.
   */
  private visibleTo(
    recipientId: string,
    since: Date,
    rules: NotificationVisibility,
  ): SQL | undefined {
    return and(
      eq(notifications.recipientId, recipientId),
      gte(notifications.updatedAt, since),
      or(
        isNull(notifications.actorId),
        and(isNull(actor.deletedAt), rules.notBlocked(notifications.actorId)),
      ),
      or(
        isNull(notifications.postId),
        and(
          isNull(posts.deletedAt),
          eq(posts.status, 'published'),
          isNull(postAuthor.deletedAt),
          rules.profileVisible(posts.authorId, postAuthor.accountType),
        ),
      ),
      or(isNull(notifications.commentId), isNull(comments.deletedAt)),
      or(
        sql`${notifications.type} <> 'connection_created'`,
        rules.connected(notifications.actorId),
      ),
    );
  }

  /** Página da lista, da mais recente (`updated_at`, id) para a mais antiga. */
  async page(input: {
    recipientId: string;
    since: Date;
    rules: NotificationVisibility;
    after: PageAnchor | undefined;
    limit: number;
  }): Promise<NotificationRecord[]> {
    const after =
      input.after === undefined
        ? undefined
        : or(
            lt(notifications.updatedAt, input.after.at),
            and(eq(notifications.updatedAt, input.after.at), lt(notifications.id, input.after.id)),
          );
    const rows = await this.db
      .select({
        id: notifications.id,
        type: notifications.type,
        count: notifications.count,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        updatedAt: notifications.updatedAt,
        actorId: actor.id,
        actorHandle: actor.handle,
        actorName: actor.name,
        actorAvatarKey: actor.avatarKey,
        actorType: actor.accountType,
        postId: posts.id,
        postType: posts.type,
        postThumbKey: sql<string | null>`(
          select pm.thumb_key from post_media pm
           where pm.post_id = ${posts.id} and pm.position = 0 and pm.status = 'ready')`,
        commentBody: comments.body,
      })
      .from(notifications)
      .leftJoin(actor, eq(actor.id, notifications.actorId))
      .leftJoin(posts, eq(posts.id, notifications.postId))
      .leftJoin(postAuthor, eq(postAuthor.id, posts.authorId))
      .leftJoin(comments, eq(comments.id, notifications.commentId))
      .where(and(this.visibleTo(input.recipientId, input.since, input.rules), after))
      .orderBy(desc(notifications.updatedAt), desc(notifications.id))
      .limit(input.limit);
    return rows;
  }

  /** Não lidas e visíveis, até `cap` (o ponto azul só precisa saber se há alguma). */
  async unreadCount(input: {
    recipientId: string;
    since: Date;
    rules: NotificationVisibility;
    cap: number;
  }): Promise<number> {
    const visible = this.db
      .select({ id: notifications.id })
      .from(notifications)
      .leftJoin(actor, eq(actor.id, notifications.actorId))
      .leftJoin(posts, eq(posts.id, notifications.postId))
      .leftJoin(postAuthor, eq(postAuthor.id, posts.authorId))
      .leftJoin(comments, eq(comments.id, notifications.commentId))
      .where(
        and(
          this.visibleTo(input.recipientId, input.since, input.rules),
          isNull(notifications.readAt),
        ),
      )
      .limit(input.cap)
      .as('visible');
    const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(visible);
    return row?.count ?? 0;
  }

  /** Marca como lidas as notificações do leitor com `updated_at` até `upTo` (6.2). */
  async markRead(recipientId: string, upTo: Date, now: Date): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.recipientId, recipientId),
          isNull(notifications.readAt),
          lte(notifications.updatedAt, upTo),
        ),
      );
  }
}
