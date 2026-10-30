import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** `personal | creator`. Imutável depois do cadastro (trigger `users_account_type_immutable`). */
export const accountType = pgEnum('account_type', ['personal', 'creator']);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Contas (arquitetura.md §6). Exclusão: `deleted_at` preenchido na hora (some de tudo) e a linha
 * é apagada pelo job do worker depois de 30 dias. O e-mail só é único entre contas ativas, para a
 * pessoa poder se cadastrar de novo; o @ continua único para sempre (A-14), inclusive depois do
 * hard delete, por meio de `retired_handles`.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    bio: text('bio'),
    /** Chave S3 do avatar processado (Fase 2). */
    avatarKey: text('avatar_key'),
    accountType: accountType('account_type').notNull(),
    emailVerifiedAt: timestamptz('email_verified_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    uniqueIndex('users_email_active_key')
      .on(t.email)
      .where(sql`deleted_at is null`),
    unique('users_handle_key').on(t.handle),
    // Alvo das FKs compostas que garantem o tipo de conta no banco (ADR 0008).
    unique('users_id_account_type_key').on(t.id, t.accountType),
    index('users_deleted_at_idx')
      .on(t.deletedAt)
      .where(sql`deleted_at is not null`),
    // Busca de criadores por prefixo do @ (Fase 3, BUS-*): só criadores ativos entram no índice.
    // Collation "C" (ordem de bytes): serve o LIKE 'abc%' e a ordem alfabética do resultado, igual
    // em qualquer locale do servidor.
    index('users_creator_handle_prefix_idx')
      .on(sql`(handle collate "C")`)
      .where(sql`account_type = 'creator' and deleted_at is null`),
    check('users_email_lowercase_chk', sql`email = lower(email)`),
    check('users_handle_format_chk', sql`handle ~ '^[a-z0-9._]{3,30}$' and handle ~ '[a-z0-9]'`),
    check('users_name_length_chk', sql`char_length(name) between 1 and 60`),
    check('users_bio_length_chk', sql`bio is null or char_length(bio) <= 150`),
  ],
);

/**
 * @ de contas excluídas, gravado na mesma transação da exclusão. Impede o reuso depois que o hard
 * delete apaga a linha de `users` (A-14). Sem FK: precisa sobreviver à conta.
 */
export const retiredHandles = pgTable(
  'retired_handles',
  {
    handle: text('handle').primaryKey(),
    retiredAt: timestamptz('retired_at').notNull().defaultNow(),
  },
  () => [check('retired_handles_lowercase_chk', sql`handle = lower(handle)`)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
