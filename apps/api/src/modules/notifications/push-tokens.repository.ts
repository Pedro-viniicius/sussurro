import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  type Database,
  type DbExecutor,
  type DbHandle,
  eq,
  pushTickets,
  pushTokens,
  sql,
} from '@sussurro/db';
import type { PushPlatform } from '@sussurro/shared';

import { rowsOf } from '../../common/db/rows.js';
import { DATABASE } from '../../infra/database/database.providers.js';

export interface PushTokenInput {
  userId: string;
  familyId: string;
  expoToken: string;
  platform: PushPlatform;
  now: Date;
}

/** Resultado do registro: criado, atualizado, passado de uma sessão morta ou recusado (CA3). */
export type RegisterOutcome = 'created' | 'refreshed' | 'claimed' | 'kept';

/**
 * Push tokens (6.4). O token fica ligado à sessão do aparelho (`refresh_family_id`); ele nunca
 * sai numa resposta, e só o dono mexe nele.
 */
@Injectable()
export class PushTokensRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  get db(): Database {
    return this.database.db;
  }

  /**
   * Registra o token do aparelho para a conta e a sessão de quem chama, na transação:
   * - novo → cria;
   * - já é da conta → atualiza plataforma, sessão e `last_seen_at` (e reativa);
   * - é de outra conta com a sessão viva → não muda nada (6.4 CA3: o token de terceiro não é
   *   desativado nem passa para quem chama);
   * - é de outra conta com a sessão encerrada (logout que não chegou, sessão vencida, conta
   *   excluída) ou desativado → passa para quem chama (o aparelho trocou de conta).
   */
  async register(executor: DbExecutor, input: PushTokenInput): Promise<RegisterOutcome> {
    const [inserted] = await executor
      .insert(pushTokens)
      .values({
        userId: input.userId,
        expoToken: input.expoToken,
        platform: input.platform,
        refreshFamilyId: input.familyId,
        createdAt: input.now,
        lastSeenAt: input.now,
      })
      .onConflictDoNothing({ target: pushTokens.expoToken })
      .returning({ id: pushTokens.id });
    if (inserted !== undefined) {
      return 'created';
    }
    const now = input.now.toISOString();
    const [current] = rowsOf<{ id: string; userId: string; alive: boolean }>(
      await executor.execute(sql`
        select pt.id, pt.user_id as "userId",
               (pt.disabled_at is null
                and exists (select 1 from users u where u.id = pt.user_id and u.deleted_at is null)
                and exists (
                  select 1 from refresh_tokens r
                   where r.user_id = pt.user_id and r.family_id = pt.refresh_family_id
                     and r.revoked_at is null and r.expires_at > ${now}::timestamptz)) as alive
          from push_tokens pt
         where pt.expo_token = ${input.expoToken}
         for update`),
    );
    if (current === undefined) {
      // Apagado entre o INSERT e o SELECT (logout concorrente): o próximo PUT do app cria de novo.
      return 'kept';
    }
    if (current.userId !== input.userId && current.alive) {
      return 'kept';
    }
    await executor
      .update(pushTokens)
      .set({
        userId: input.userId,
        platform: input.platform,
        refreshFamilyId: input.familyId,
        lastSeenAt: input.now,
        disabledAt: null,
        ...(current.userId === input.userId ? {} : { createdAt: input.now }),
      })
      .where(eq(pushTokens.id, current.id));
    if (current.userId !== input.userId) {
      // Os tickets do dono anterior não servem para a conta nova.
      await executor.delete(pushTickets).where(eq(pushTickets.pushTokenId, current.id));
      return 'claimed';
    }
    return 'refreshed';
  }

  /** Mantém só os `limit` tokens mais recentes da conta (o mais antigo sai). */
  async trimToLimit(executor: DbExecutor, userId: string, limit: number): Promise<void> {
    await executor.execute(sql`
      delete from push_tokens
       where user_id = ${userId}::uuid
         and id not in (
           select id from push_tokens
            where user_id = ${userId}::uuid
            order by last_seen_at desc, id desc
            limit ${limit})`);
  }

  /** `DELETE /me/push-tokens`: só o token de quem chama; o de outra conta não muda (6.4 CA3). */
  async removeOwn(userId: string, expoToken: string): Promise<void> {
    await this.db
      .delete(pushTokens)
      .where(and(eq(pushTokens.userId, userId), eq(pushTokens.expoToken, expoToken)));
  }

  /** Logout deste aparelho (AUTH-12) e sessão revogada por reuso: o token daquela sessão sai. */
  async removeFamily(executor: DbExecutor, userId: string, familyId: string): Promise<void> {
    await executor
      .delete(pushTokens)
      .where(and(eq(pushTokens.userId, userId), eq(pushTokens.refreshFamilyId, familyId)));
  }

  /** "Sair de todos os aparelhos", troca de senha e exclusão de conta: todos os tokens saem. */
  async removeAllForUser(executor: DbExecutor, userId: string): Promise<void> {
    await executor.delete(pushTokens).where(eq(pushTokens.userId, userId));
  }
}
