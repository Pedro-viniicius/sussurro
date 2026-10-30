import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './users.ts';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const postType = pgEnum('post_type', ['photo', 'text', 'reel']);
export const postStatus = pgEnum('post_status', ['draft', 'processing', 'published', 'failed']);
export const mediaKind = pgEnum('media_kind', ['image', 'video']);
export const mediaStatus = pgEnum('media_status', [
  'pending_upload',
  'processing',
  'ready',
  'failed',
]);

/**
 * Publicações (arquitetura.md §6). Texto nasce `published`; foto nasce `draft` e passa por
 * `processing` até o worker terminar (ADR 0009). O feed ordena por `published_at`, que tem
 * precisão de milissegundo (CHECK): é o que o cursor carrega, sem perder nem repetir posts.
 * Exclusão: `deleted_at` na hora; o job do worker apaga os objetos do S3 e a linha.
 */
export const posts = pgTable(
  'posts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: postType('type').notNull(),
    caption: text('caption'),
    text: text('text'),
    status: postStatus('status').notNull(),
    likeCount: integer('like_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    publishedAt: timestamptz('published_at'),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    // Feed (LATERAL por autor) e abas do perfil vistas por outras contas (ADR 0005).
    index('posts_author_type_pub_idx')
      .on(t.authorId, t.type, t.publishedAt.desc(), t.id.desc())
      .where(sql`status = 'published' and deleted_at is null`),
    // Perfil visto pelo dono (inclui processing/failed), contagem e FK em cascata.
    index('posts_author_created_idx').on(t.authorId, t.type, t.createdAt.desc()),
    // Job de rascunhos órfãos (2.11).
    index('posts_pending_idx')
      .on(t.status, t.createdAt)
      .where(sql`status in ('draft', 'processing')`),
    // Job dos objetos de posts apagados (2.9 CA3).
    index('posts_deleted_idx')
      .on(t.deletedAt)
      .where(sql`deleted_at is not null`),
    check('posts_text_type_chk', sql`(type = 'text') = (text is not null)`),
    check('posts_text_length_chk', sql`text is null or char_length(text) between 1 and 280`),
    check(
      'posts_caption_chk',
      sql`caption is null or (type <> 'text' and char_length(caption) <= 2200)`,
    ),
    check('posts_text_published_chk', sql`type <> 'text' or status = 'published'`),
    check('posts_published_at_chk', sql`(status = 'published') = (published_at is not null)`),
    check(
      'posts_published_at_ms_chk',
      sql`published_at is null or published_at = date_trunc('milliseconds', published_at)`,
    ),
    check('posts_like_count_chk', sql`like_count >= 0`),
    check('posts_comment_count_chk', sql`comment_count >= 0`),
  ],
);

/**
 * Imagens (e, desde a Fase 5, o vídeo do reel) de um post. O `id` é a chave do objeto no S3:
 * `incoming/{autor}/{id}` (privado, apagado depois de processar) e `media/{id}/full.jpg` e
 * `thumb.jpg` (servidos por URL assinada). Reel (ADR 0006): o vídeo vai para
 * `media/{id}/video.mp4` e o poster para `thumb_key`; o poster enviado pelo app chega em
 * `poster_incoming_key` (`incoming/{autor}/{id}-poster`).
 */
export const postMedia = pgTable(
  'post_media',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    kind: mediaKind('kind').notNull(),
    /** Declarado pelo app; o worker confirma pelos magic bytes. */
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    incomingKey: text('incoming_key').notNull(),
    storageKey: text('storage_key'),
    thumbKey: text('thumb_key'),
    width: integer('width'),
    height: integer('height'),
    /**
     * Vídeo: a duração declarada no rascunho e, depois de processado, a medida no arquivo (o
     * worker confere o limite de 90 s, D10).
     */
    durationS: numeric('duration_s', { precision: 6, scale: 2, mode: 'number' }),
    /** Só no vídeo (Fase 5): o poster enviado pelo app, ainda em `incoming/`. */
    posterIncomingKey: text('poster_incoming_key'),
    posterMime: text('poster_mime'),
    posterSizeBytes: integer('poster_size_bytes'),
    status: mediaStatus('status').notNull().default('pending_upload'),
    /** Id do job do `VideoProcessor` (MediaConvert); o evento de conclusão precisa bater com ele. */
    processorJobId: text('processor_job_id'),
    error: text('error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('post_media_post_position_key').on(t.postId, t.position),
    // Processamento travado (worker caiu nas 3 tentativas).
    index('post_media_processing_idx')
      .on(t.updatedAt)
      .where(sql`status = 'processing'`),
    check('post_media_position_chk', sql`position between 0 and 3`),
    check('post_media_video_position_chk', sql`kind <> 'video' or position = 0`),
    check('post_media_size_chk', sql`size_bytes > 0`),
    // Fase 5 (reels): vídeo sempre com duração positiva; o poster só existe no vídeo e completo.
    check(
      'post_media_video_duration_chk',
      sql`kind <> 'video' or (duration_s is not null and duration_s > 0)`,
    ),
    check(
      'post_media_poster_chk',
      sql`(poster_incoming_key is null) = (poster_mime is null) and (poster_incoming_key is null) = (poster_size_bytes is null)`,
    ),
    check('post_media_poster_video_chk', sql`kind = 'video' or poster_incoming_key is null`),
    check('post_media_poster_size_chk', sql`poster_size_bytes is null or poster_size_bytes > 0`),
  ],
);

/**
 * Curtidas (ADR 0004): não existe rota que liste quem curtiu, só `like_count` (desnormalizado em
 * `posts`, atualizado na mesma transação) e `likedByMe`.
 */
export const likes = pgTable(
  'likes',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'likes_pkey', columns: [t.postId, t.userId] }),
    // Exclusão de conta: curtidas da pessoa somem na hora (A-13) e o hard delete recalcula.
    index('likes_user_idx').on(t.userId),
  ],
);

/**
 * Comentários e respostas (1 nível; a aplicação garante que o pai não tem pai). Exclusão é
 * `deleted_at`; apagar um comentário apaga as respostas dele.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id, {
      onDelete: 'cascade',
    }),
    body: text('body').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    // Sem WHERE: também atende o ON DELETE CASCADE de posts (que alcança os apagados).
    index('comments_post_idx').on(t.postId, t.createdAt, t.id),
    index('comments_parent_idx')
      .on(t.parentId, t.createdAt)
      .where(sql`parent_id is not null`),
    index('comments_author_idx').on(t.authorId),
    check('comments_body_length_chk', sql`char_length(body) between 1 and 500`),
    check('comments_not_self_parent_chk', sql`parent_id is null or parent_id <> id`),
  ],
);

/**
 * Trocas de foto de perfil (história 2.4): o mesmo pipeline das fotos de post. `requested_at` é
 * quando o app pediu a troca (`PUT /me/avatar`); a troca mais recente vence.
 */
export const avatarUploads = pgTable(
  'avatar_uploads',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    incomingKey: text('incoming_key').notNull(),
    storageKey: text('storage_key'),
    status: mediaStatus('status').notNull().default('pending_upload'),
    error: text('error'),
    requestedAt: timestamptz('requested_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('avatar_uploads_user_idx').on(t.userId, t.createdAt),
    index('avatar_uploads_created_idx').on(t.createdAt),
    check('avatar_uploads_size_chk', sql`size_bytes > 0`),
  ],
);

export type PostRow = typeof posts.$inferSelect;
export type NewPostRow = typeof posts.$inferInsert;
export type PostMediaRow = typeof postMedia.$inferSelect;
export type NewPostMediaRow = typeof postMedia.$inferInsert;
export type LikeRow = typeof likes.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type AvatarUploadRow = typeof avatarUploads.$inferSelect;
export type PostTypeValue = (typeof postType.enumValues)[number];
export type PostStatusValue = (typeof postStatus.enumValues)[number];
export type MediaStatusValue = (typeof mediaStatus.enumValues)[number];
export type MediaKindValue = (typeof mediaKind.enumValues)[number];
