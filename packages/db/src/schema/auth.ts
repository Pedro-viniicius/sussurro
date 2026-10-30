import { sql } from 'drizzle-orm';
import { customType, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './users.ts';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** SHA-256 de um token opaco. O token em si nunca é gravado. */
const sha256Bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

/**
 * Refresh tokens (ADR 0007): opacos de 256 bits, guardados como SHA-256, rotacionados a cada uso
 * dentro de uma família (uma por login/aparelho). Reapresentar um token já usado depois da janela
 * de 20 s revoga a família inteira.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: sha256Bytes('token_hash').notNull().unique('refresh_tokens_token_hash_key'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    /** Marcado na rotação. */
    usedAt: timestamptz('used_at'),
    /** Sucessor emitido na rotação. */
    replacedBy: uuid('replaced_by'),
    revokedAt: timestamptz('revoked_at'),
    /** Ex.: "iPhone · iOS 27". Sem IP, por minimização. */
    deviceLabel: text('device_label'),
  },
  (t) => [
    index('refresh_tokens_user_id_idx').on(t.userId),
    index('refresh_tokens_family_id_idx').on(t.familyId),
    index('refresh_tokens_expires_at_idx').on(t.expiresAt),
  ],
);

/** Finalidade do token enviado por e-mail (D6). */
export const emailTokenPurpose = pgEnum('email_token_purpose', ['verify_email', 'reset_password']);

/**
 * Tokens de uso único enviados por e-mail: confirmação de e-mail (X.3) e redefinição de senha
 * (1.10). Guardados como SHA-256, com validade curta. `email` fixa o endereço para o qual o link
 * foi mandado.
 */
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: emailTokenPurpose('purpose').notNull(),
    email: text('email').notNull(),
    tokenHash: sha256Bytes('token_hash').notNull().unique('email_tokens_token_hash_key'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
  },
  (t) => [
    index('email_tokens_user_id_purpose_idx').on(t.userId, t.purpose),
    index('email_tokens_expires_at_idx').on(t.expiresAt),
  ],
);

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type EmailTokenRow = typeof emailTokens.$inferSelect;
export type EmailTokenPurpose = (typeof emailTokenPurpose.enumValues)[number];
