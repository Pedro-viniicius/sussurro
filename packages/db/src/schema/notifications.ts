import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { comments, posts } from './posts.ts';
import { users } from './users.ts';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Tipos da v1 (ADR 0011). */
export const notificationType = pgEnum('notification_type', [
  'post_liked',
  'post_commented',
  'comment_replied',
  'new_followers',
  'connection_created',
]);

/**
 * Notificações no app (ADR 0011, arquitetura.md §6; Fase 6). Gravadas pela API na mesma transação
 * do evento. Regras garantidas pelo banco:
 * - seguidores (`new_followers`) são anônimos: `actor_id`, `post_id` e `comment_id` nulos e
 *   `payload` vazio (CHECK), um por dia em America/Sao_Paulo (`bucket_key`, único por conta);
 * - curtida: uma por (quem recebe, quem curtiu, post), pelo índice único parcial (curtir e
 *   descurtir de novo não cria outra);
 * - ninguém é notificado da própria ação.
 * Post, comentário ou conta apagados de vez levam a notificação em cascata; antes disso, a leitura
 * esconde a notificação (NOT-09). Retenção: 90 dias sem atualização (job do worker).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationType('type').notNull(),
    /** Quem agiu. Sempre nulo em `new_followers` (CHECK). */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    /** O comentário ou a resposta que gerou a notificação (o trecho é lido dele na hora). */
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    /** Agregação: quantas pessoas novas seguiram no dia (`new_followers`); 1 nos outros tipos. */
    count: integer('count').notNull().default(1),
    /** `new_followers`: `nf:YYYY-MM-DD` (dia em America/Sao_Paulo). */
    bucketKey: text('bucket_key'),
    /** Reservado; vazio na v1. Nunca guarda ids de quem seguiu (CHECK em `new_followers`). */
    payload: jsonb('payload').notNull().default({}),
    readAt: timestamptz('read_at'),
    createdAt: timestamptz('created_at').notNull(),
    /** Ordem da lista; o upsert de seguidores atualiza (e zera `read_at`). */
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    // Lista (`GET /notifications`, cursor por updated_at e id).
    index('notifications_recipient_updated_idx').on(t.recipientId, t.updatedAt.desc(), t.id.desc()),
    // Ponto azul (`unread-count`).
    index('notifications_unread_idx')
      .on(t.recipientId)
      .where(sql`read_at is null`),
    // Upsert dos seguidores por dia.
    uniqueIndex('notifications_bucket_key')
      .on(t.recipientId, t.bucketKey)
      .where(sql`bucket_key is not null`),
    // Uma notificação por curtida (ator, post): curtir/descurtir repetido não cria outra (NOT-07).
    uniqueIndex('notifications_like_key')
      .on(t.recipientId, t.actorId, t.postId)
      .where(sql`type = 'post_liked'`),
    // ON DELETE CASCADE de users (como ator), posts e comments, e a limpeza do bloqueio.
    index('notifications_actor_idx')
      .on(t.actorId)
      .where(sql`actor_id is not null`),
    index('notifications_post_idx')
      .on(t.postId)
      .where(sql`post_id is not null`),
    index('notifications_comment_idx')
      .on(t.commentId)
      .where(sql`comment_id is not null`),
    // Retenção de 90 dias (job do worker).
    index('notifications_updated_idx').on(t.updatedAt),
    check(
      'notifications_new_followers_anonymous_chk',
      sql`type <> 'new_followers' or (actor_id is null and post_id is null and comment_id is null and payload = '{}'::jsonb)`,
    ),
    check('notifications_actor_chk', sql`type = 'new_followers' or actor_id is not null`),
    check('notifications_not_self_chk', sql`actor_id is null or actor_id <> recipient_id`),
    check(
      'notifications_post_chk',
      sql`(type in ('post_liked', 'post_commented', 'comment_replied')) = (post_id is not null)`,
    ),
    check(
      'notifications_comment_chk',
      sql`(type in ('post_commented', 'comment_replied')) = (comment_id is not null)`,
    ),
    check('notifications_bucket_chk', sql`(type = 'new_followers') = (bucket_key is not null)`),
    check(
      'notifications_bucket_format_chk',
      sql`bucket_key is null or bucket_key ~ '^nf:[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ),
    check('notifications_count_chk', sql`count >= 1 and (type = 'new_followers' or count = 1)`),
  ],
);

/**
 * Push tokens do Expo (história 6.4; arquitetura.md §6). Um por aparelho (`expo_token` único),
 * ligado à sessão do aparelho (`refresh_family_id`): o logout daquela sessão apaga o token
 * (AUTH-12), e o worker só envia para tokens de sessões vivas. `disabled_at`: o Expo respondeu
 * `DeviceNotRegistered` (app desinstalado ou permissão retirada). Nunca sai em resposta da API.
 */
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expoToken: text('expo_token').notNull(),
    platform: text('platform').notNull(),
    /** Família de refresh (a sessão do aparelho) que registrou o token. */
    refreshFamilyId: uuid('refresh_family_id').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    disabledAt: timestamptz('disabled_at'),
  },
  (t) => [
    unique('push_tokens_expo_token_key').on(t.expoToken),
    // Tokens da conta (envio, limite por conta) e o ON DELETE CASCADE de users.
    index('push_tokens_user_idx').on(t.userId, t.lastSeenAt.desc()),
    // Logout de um aparelho (AUTH-12).
    index('push_tokens_family_idx').on(t.refreshFamilyId),
    check('push_tokens_platform_chk', sql`platform in ('ios', 'android')`),
    check(
      'push_tokens_format_chk',
      sql`char_length(expo_token) <= 255 and expo_token ~ '^Expo(nent)?PushToken\\[[^][:space:]]+\\]$'`,
    ),
  ],
);

/**
 * Tickets do Expo Push à espera do recibo (ADR 0011): o job do worker consulta os recibos depois de
 * ~15 min e desativa o token com `DeviceNotRegistered`. Só o id do ticket e o token; nenhum
 * conteúdo da mensagem. Tickets com mais de 24 h saem (o Expo guarda o recibo por cerca de um dia).
 */
export const pushTickets = pgTable(
  'push_tickets',
  {
    ticketId: text('ticket_id').primaryKey(),
    pushTokenId: uuid('push_token_id')
      .notNull()
      .references(() => pushTokens.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull(),
  },
  (t) => [
    index('push_tickets_created_idx').on(t.createdAt),
    index('push_tickets_token_idx').on(t.pushTokenId),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;
export type NotificationTypeValue = (typeof notificationType.enumValues)[number];
export type PushTokenRow = typeof pushTokens.$inferSelect;
export type PushTicketRow = typeof pushTickets.$inferSelect;
