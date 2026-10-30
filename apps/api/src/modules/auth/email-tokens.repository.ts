import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  type Database,
  type DbExecutor,
  type DbHandle,
  type EmailTokenPurpose,
  emailTokens,
  eq,
  gt,
  isNull,
  type Transaction,
  users,
} from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

export interface NewEmailToken {
  userId: string;
  purpose: EmailTokenPurpose;
  email: string;
  tokenHash: Uint8Array;
  createdAt: Date;
  expiresAt: Date;
}

/** Consultas de `email_tokens` (verificação de e-mail e redefinição de senha, D6). */
@Injectable()
export class EmailTokensRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  /** Um link novo invalida os anteriores da mesma finalidade. */
  async invalidateUnused(
    executor: DbExecutor,
    userId: string,
    purpose: EmailTokenPurpose,
    now: Date,
  ): Promise<void> {
    await executor
      .update(emailTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.purpose, purpose),
          isNull(emailTokens.usedAt),
        ),
      );
  }

  async invalidateAllForUser(executor: DbExecutor, userId: string, now: Date): Promise<void> {
    await executor
      .update(emailTokens)
      .set({ usedAt: now })
      .where(and(eq(emailTokens.userId, userId), isNull(emailTokens.usedAt)));
  }

  async insert(executor: DbExecutor, token: NewEmailToken): Promise<void> {
    await executor.insert(emailTokens).values(token);
  }

  /** Token ainda utilizável (não usado, não vencido, conta ativa), travado para uso único. */
  async findUsableForUpdate(
    tx: Transaction,
    tokenHash: Uint8Array,
    purpose: EmailTokenPurpose,
    now: Date,
  ) {
    const [row] = await tx
      .select({
        id: emailTokens.id,
        userId: emailTokens.userId,
        email: emailTokens.email,
        currentEmail: users.email,
      })
      .from(emailTokens)
      .innerJoin(users, eq(users.id, emailTokens.userId))
      .where(
        and(
          eq(emailTokens.tokenHash, tokenHash),
          eq(emailTokens.purpose, purpose),
          isNull(emailTokens.usedAt),
          gt(emailTokens.expiresAt, now),
          isNull(users.deletedAt),
        ),
      )
      .limit(1)
      .for('update', { of: emailTokens });
    return row;
  }

  async markUsed(tx: Transaction, id: string, now: Date): Promise<void> {
    await tx.update(emailTokens).set({ usedAt: now }).where(eq(emailTokens.id, id));
  }
}
