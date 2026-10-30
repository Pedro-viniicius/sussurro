import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  type Database,
  type DbExecutor,
  type DbHandle,
  eq,
  isNull,
  retiredHandles,
  sql,
  users,
} from '@sussurro/db';
import type { AccountType } from '@sussurro/shared';

import { DATABASE } from '../../infra/database/database.providers.js';

export interface NewAccount {
  email: string;
  passwordHash: string;
  handle: string;
  name: string;
  accountType: AccountType;
  now: Date;
}

/** Consultas da tabela `users` que pertencem à autenticação (credenciais, exclusão). */
@Injectable()
export class CredentialsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  async findActiveByEmail(email: string) {
    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        accountType: users.accountType,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    return row;
  }

  async findActiveById(id: string) {
    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        accountType: users.accountType,
        passwordHash: users.passwordHash,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row;
  }

  /** Usado pelo guard em toda requisição autenticada: conta existe e não foi excluída (CONTA-07). */
  async findAuthSubject(id: string) {
    const [row] = await this.db
      .select({
        id: users.id,
        accountType: users.accountType,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row;
  }

  async isEmailInUse(email: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    return row !== undefined;
  }

  /** @ em uso por qualquer conta (inclusive excluída) ou aposentado depois do hard delete (A-14). */
  async isHandleUnavailable(handle: string): Promise<boolean> {
    const [inUse] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);
    if (inUse !== undefined) {
      return true;
    }
    const [retired] = await this.db
      .select({ handle: retiredHandles.handle })
      .from(retiredHandles)
      .where(eq(retiredHandles.handle, handle))
      .limit(1);
    return retired !== undefined;
  }

  async insertAccount(executor: DbExecutor, account: NewAccount) {
    const [row] = await executor
      .insert(users)
      .values({
        email: account.email,
        passwordHash: account.passwordHash,
        handle: account.handle,
        name: account.name,
        accountType: account.accountType,
        createdAt: account.now,
        updatedAt: account.now,
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        accountType: users.accountType,
      });
    if (row === undefined) {
      throw new Error('INSERT em users não devolveu a linha');
    }
    return row;
  }

  /**
   * Troca a senha. Quem abriu o link do e-mail provou que o endereço é dele: a conta passa a ter o
   * e-mail confirmado.
   */
  async updatePassword(
    executor: DbExecutor,
    userId: string,
    passwordHash: string,
    now: Date,
  ): Promise<void> {
    await executor
      .update(users)
      .set({
        passwordHash,
        updatedAt: now,
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  }

  async markEmailVerified(executor: DbExecutor, userId: string, now: Date): Promise<void> {
    await executor
      .update(users)
      .set({
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  }

  /**
   * Exclusão de conta: some na hora (`deleted_at`) e o @ vai para `retired_handles` na mesma
   * transação, para nunca ser reutilizado (A-14). O hard delete fica com o job do worker.
   */
  async softDelete(executor: DbExecutor, userId: string, now: Date): Promise<boolean> {
    const [deleted] = await executor
      .update(users)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning({ handle: users.handle });
    if (deleted === undefined) {
      return false;
    }
    await executor
      .insert(retiredHandles)
      .values({ handle: deleted.handle, retiredAt: now })
      .onConflictDoNothing();
    return true;
  }
}
