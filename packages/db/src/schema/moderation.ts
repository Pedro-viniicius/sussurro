import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { comments, posts } from './posts.ts';
import { users } from './users.ts';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** O que foi denunciado (X.1). */
export const reportTargetType = pgEnum('report_target_type', ['post', 'comment', 'account']);

/** Motivos da denúncia: lista curta e fechada (X.1, Fase 3). Rótulos em `packages/shared`. */
export const reportReason = pgEnum('report_reason', [
  'spam',
  'harassment',
  'hate',
  'violence',
  'sexual',
  'self_harm',
  'impersonation',
  'other',
]);

/**
 * Denúncias (X.1, D5; Fase 3). Fila de moderação mínima: cada linha nova manda um e-mail para
 * `MODERATION_EMAIL`; não há painel. A pessoa denunciada nunca é avisada. Repetir a denúncia do
 * mesmo alvo pela mesma pessoa não cria outra linha (índices únicos por tipo de alvo).
 *
 * Retenção: some com o hard delete de quem denunciou ou da conta denunciada (`ON DELETE CASCADE`).
 * Se só o post ou o comentário for apagado de vez, a denúncia fica, sem a referência
 * (`ON DELETE SET NULL`), com a conta autora em `target_user_id`.
 */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: reportTargetType('target_type').notNull(),
    /** A conta denunciada ou a autora do post ou do comentário. */
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').references(() => posts.id, { onDelete: 'set null' }),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'set null' }),
    reason: reportReason('reason').notNull(),
    /** Texto opcional de quem denunciou (até 500 caracteres). */
    details: text('details'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // Idempotência: uma denúncia por pessoa e alvo.
    uniqueIndex('reports_post_key')
      .on(t.reporterId, t.postId)
      .where(sql`target_type = 'post'`),
    uniqueIndex('reports_comment_key')
      .on(t.reporterId, t.commentId)
      .where(sql`target_type = 'comment'`),
    uniqueIndex('reports_account_key')
      .on(t.reporterId, t.targetUserId)
      .where(sql`target_type = 'account'`),
    // Fila de moderação (mais antigas primeiro) e as FKs em cascata.
    index('reports_created_idx').on(t.createdAt),
    index('reports_target_user_idx').on(t.targetUserId),
    index('reports_post_idx')
      .on(t.postId)
      .where(sql`post_id is not null`),
    index('reports_comment_idx')
      .on(t.commentId)
      .where(sql`comment_id is not null`),
    check(
      'reports_target_chk',
      sql`(target_type = 'post' and comment_id is null)
        or (target_type = 'comment' and post_id is null)
        or (target_type = 'account' and post_id is null and comment_id is null)`,
    ),
    check('reports_not_self_chk', sql`reporter_id <> target_user_id`),
    check('reports_details_chk', sql`details is null or char_length(details) between 1 and 500`),
  ],
);

export type ReportRow = typeof reports.$inferSelect;
export type NewReportRow = typeof reports.$inferInsert;
export type ReportTargetTypeValue = (typeof reportTargetType.enumValues)[number];
export type ReportReasonValue = (typeof reportReason.enumValues)[number];
