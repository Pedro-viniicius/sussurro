import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  type Database,
  type DbExecutor,
  type DbHandle,
  eq,
  isNull,
  refreshTokens,
  type Transaction,
  users,
} from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

export interface NewRefreshToken {
  userId: string;
  familyId: string;
  tokenHash: Uint8Array;
  createdAt: Date;
  expiresAt: Date;
  deviceLabel: string | null;
}

/** Consultas de `refresh_tokens` (ADR 0007). */
@Injectable()
export class SessionsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  async insert(executor: DbExecutor, token: NewRefreshToken): Promise<string> {
    const [row] = await executor
      .insert(refreshTokens)
      .values(token)
      .returning({ id: refreshTokens.id });
    if (row === undefined) {
      throw new Error('INSERT em refresh_tokens não devolveu a linha');
    }
    return row.id;
  }

  /** Trava a linha do token apresentado: rotações concorrentes do mesmo token são serializadas. */
  async findByHashForUpdate(tx: Transaction, tokenHash: Uint8Array) {
    const [row] = await tx
      .select({
        id: refreshTokens.id,
        userId: refreshTokens.userId,
        familyId: refreshTokens.familyId,
        usedAt: refreshTokens.usedAt,
        revokedAt: refreshTokens.revokedAt,
        expiresAt: refreshTokens.expiresAt,
        deviceLabel: refreshTokens.deviceLabel,
        accountType: users.accountType,
        userDeletedAt: users.deletedAt,
      })
      .from(refreshTokens)
      .innerJoin(users, eq(users.id, refreshTokens.userId))
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1)
      .for('update', { of: refreshTokens });
    return row;
  }

  async markUsed(tx: Transaction, id: string, now: Date, successorId: string): Promise<void> {
    await tx
      .update(refreshTokens)
      .set({ usedAt: now, replacedBy: successorId })
      .where(eq(refreshTokens.id, id));
  }

  async setSuccessor(tx: Transaction, id: string, successorId: string): Promise<void> {
    await tx.update(refreshTokens).set({ replacedBy: successorId }).where(eq(refreshTokens.id, id));
  }

  /**
   * Revoga o token ativo da família (o sucessor ainda não usado), mantendo os já usados: assim um
   * reuso posterior de um token antigo continua sendo detectado como roubo.
   */
  async revokeUnusedInFamily(tx: Transaction, familyId: string, now: Date): Promise<void> {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(refreshTokens.familyId, familyId),
          isNull(refreshTokens.usedAt),
          isNull(refreshTokens.revokedAt),
        ),
      );
  }

  async revokeFamily(
    executor: DbExecutor,
    userId: string,
    familyId: string,
    now: Date,
  ): Promise<void> {
    await executor
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.familyId, familyId),
          isNull(refreshTokens.revokedAt),
        ),
      );
  }

  async revokeAllForUser(executor: DbExecutor, userId: string, now: Date): Promise<void> {
    await executor
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}
