import {
  and,
  avatarUploads,
  comments,
  connectionRequests,
  type Database,
  emailTokens,
  eq,
  inArray,
  isNotNull,
  likes,
  lt,
  lte,
  ne,
  notifications,
  postMedia,
  posts,
  refreshTokens,
  sql,
  users,
} from '@sussurro/db';

import {
  type CleanupResult,
  postMediaKeyColumns,
  postMediaObjectKeys,
  runCleanup,
  uniqueKeys,
} from './cleanup.js';
import type { ObjectStorage } from '../infra/storage.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Contas apagadas por lote: transações curtas, sem travar a tabela. */
export const PURGE_BATCH_SIZE = 100;

export interface MaintenanceOptions {
  now: Date;
  purgeAfterDays: number;
  /** Rascunhos e uploads de avatar abandonados (2.11). */
  draftTtlHours: number;
  /** Mídia presa em `processing` (MID-10). */
  processingTimeoutMin: number;
}

export interface PurgeResult {
  accounts: number;
  /** Objetos do S3 apagados (mídia dos posts, avatar e uploads de avatar). */
  objects: number;
  /** Posts de outras contas com `like_count`/`comment_count` recalculados (A-12). */
  recalculatedPosts: number;
}

export interface MaintenanceResult extends CleanupResult {
  purgedAccounts: number;
  purgedObjects: number;
  recalculatedPosts: number;
  deletedRefreshTokens: number;
  deletedEmailTokens: number;
  /** Pedidos de conexão pendentes que passaram dos 120 s, marcados como `expired` (PROX-15). */
  expiredConnectionRequests: number;
  /** Pedidos de conexão encerrados há mais de 30 dias, apagados (retenção). */
  deletedConnectionRequests: number;
  /** Fase 6: notificações sem atualização há mais de 90 dias, apagadas (ADR 0011). */
  deletedNotifications: number;
  /** Fase 6: push tokens desativados há 30 dias ou de sessões que não existem mais. */
  deletedPushTokens: number;
}

/** Retenção dos pedidos de conexão que não estão mais pendentes (arquitetura.md §6). */
export const CONNECTION_REQUEST_RETENTION_DAYS = 30;
/** Retenção das notificações (ADR 0011), contada do último `updated_at`. */
export const NOTIFICATION_RETENTION_DAYS = 90;
/** Push token desativado (`DeviceNotRegistered`) fica 30 dias e sai. */
export const DISABLED_PUSH_TOKEN_RETENTION_DAYS = 30;

/**
 * Retenção da Fase 6 (ADR 0011): notificações com mais de 90 dias sem atualização e push tokens que
 * não servem mais (desativados há 30 dias, ou cuja sessão foi revogada, venceu ou foi apagada: o
 * aparelho não está mais logado). O mínimo de dados guardado.
 */
export async function purgeNotificationsAndPushTokens(db: Database, now: Date) {
  const notificationCutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
  const deletedNotifications = await db
    .delete(notifications)
    .where(lt(notifications.updatedAt, notificationCutoff))
    .returning({ id: notifications.id });
  const disabledCutoff = new Date(now.getTime() - DISABLED_PUSH_TOKEN_RETENTION_DAYS * DAY_MS);
  const deletedTokens = await db.execute(sql`
    with removed as (
      delete from push_tokens pt
       where pt.disabled_at < ${disabledCutoff.toISOString()}::timestamptz
          or not exists (
            select 1 from refresh_tokens r
             where r.user_id = pt.user_id and r.family_id = pt.refresh_family_id
               and r.revoked_at is null and r.expires_at > ${now.toISOString()}::timestamptz)
      returning 1)
    select count(*)::int as n from removed`);
  const [row] = (deletedTokens as { rows: { n: number }[] }).rows;
  return { notifications: deletedNotifications.length, pushTokens: row?.n ?? 0 };
}

/** `p.id in (...)` com uuids como parâmetros (igual no node-postgres e no PGlite). */
function uuidList(ids: readonly string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/**
 * Recalcula os contadores desnormalizados (A-12): curtidas de contas ativas e comentários vivos
 * (de contas ativas, com o pai vivo). O `ON DELETE CASCADE` apaga as linhas, mas não ajusta os
 * números.
 */
export async function recalculatePostCounters(
  db: Pick<Database, 'execute'>,
  postIds: readonly string[],
): Promise<void> {
  if (postIds.length === 0) {
    return;
  }
  await db.execute(sql`
    update posts p
       set like_count = (
             select count(*)::int from likes l join users u on u.id = l.user_id
              where l.post_id = p.id and u.deleted_at is null),
           comment_count = (
             select count(*)::int from comments c
               join users u on u.id = c.author_id
               left join comments parent on parent.id = c.parent_id
              where c.post_id = p.id and c.deleted_at is null and u.deleted_at is null
                and (c.parent_id is null or parent.deleted_at is null))
     where p.id in (${uuidList(postIds)})
  `);
}

/**
 * Hard delete das contas excluídas há mais de `purgeAfterDays` (arquitetura.md §15, CONTA-05).
 * Por lote, numa transação:
 * 1. reserva as contas (`FOR UPDATE SKIP LOCKED`: duas réplicas do worker não disputam linhas);
 * 2. apaga do S3 a mídia dos posts, a foto de perfil e os uploads de avatar;
 * 3. apaga as contas (sessões, tokens, posts, curtidas, comentários, conexões, follows e, desde a
 *    Fase 3, bloqueios e denúncias feitas ou recebidas caem em cascata; o @ continua em
 *    `retired_handles`, A-14);
 * 4. recalcula os contadores dos posts de outras contas que elas curtiram ou comentaram (A-12).
 * Se o S3 falhar, a transação desfaz tudo e o próximo ciclo tenta de novo.
 */
export async function purgeDeletedAccounts(
  db: Database,
  storage: ObjectStorage,
  cutoff: Date,
  batchSize: number = PURGE_BATCH_SIZE,
): Promise<PurgeResult> {
  const total: PurgeResult = { accounts: 0, objects: 0, recalculatedPosts: 0 };
  for (;;) {
    const batch = await db.transaction(async (tx): Promise<PurgeResult> => {
      const accounts = await tx
        .select({ id: users.id, avatarKey: users.avatarKey })
        .from(users)
        .where(and(isNotNull(users.deletedAt), lt(users.deletedAt, cutoff)))
        .orderBy(users.deletedAt)
        .limit(batchSize)
        .for('update', { skipLocked: true });
      if (accounts.length === 0) {
        return { accounts: 0, objects: 0, recalculatedPosts: 0 };
      }
      const ids = accounts.map((account) => account.id);

      const media = await tx
        .select(postMediaKeyColumns)
        .from(postMedia)
        .innerJoin(posts, eq(posts.id, postMedia.postId))
        .where(inArray(posts.authorId, ids));
      const uploads = await tx
        .select({ incoming: avatarUploads.incomingKey, storage: avatarUploads.storageKey })
        .from(avatarUploads)
        .where(inArray(avatarUploads.userId, ids));
      const keys = uniqueKeys([
        ...media.flatMap(postMediaObjectKeys),
        ...uploads.flatMap((item) => [item.incoming, item.storage]),
        ...accounts.map((account) => account.avatarKey),
      ]);

      // Posts de outras contas que estas curtiram ou comentaram (os delas somem com elas).
      const liked = await tx
        .selectDistinct({ postId: likes.postId })
        .from(likes)
        .where(inArray(likes.userId, ids));
      const commented = await tx
        .selectDistinct({ postId: comments.postId })
        .from(comments)
        .where(inArray(comments.authorId, ids));
      const touched = [...new Set([...liked, ...commented].map((row) => row.postId))];

      if (keys.length > 0) {
        await storage.deleteObjects(keys);
      }
      await tx.delete(users).where(inArray(users.id, ids));
      const remaining =
        touched.length === 0
          ? []
          : await tx.select({ id: posts.id }).from(posts).where(inArray(posts.id, touched));
      await recalculatePostCounters(
        tx,
        remaining.map((row) => row.id),
      );
      return { accounts: ids.length, objects: keys.length, recalculatedPosts: remaining.length };
    });
    total.accounts += batch.accounts;
    total.objects += batch.objects;
    total.recalculatedPosts += batch.recalculatedPosts;
    if (batch.accounts < batchSize) {
      return total;
    }
  }
}

/** Refresh tokens e links de e-mail vencidos não servem para nada: são apagados. */
export async function deleteExpiredTokens(db: Database, now: Date) {
  const refresh = await db
    .delete(refreshTokens)
    .where(lt(refreshTokens.expiresAt, now))
    .returning({ id: refreshTokens.id });
  const email = await db
    .delete(emailTokens)
    .where(lt(emailTokens.expiresAt, now))
    .returning({ id: emailTokens.id });
  return { refresh: refresh.length, email: email.length };
}

/**
 * Pedidos de conexão (Fase 4, ADR 0003). A API já marca os vencidos de forma preguiçosa, em cada
 * operação do par; aqui ficam os que ninguém tocou (`pending` além de `expires_at` → `expired`,
 * PROX-15). E a retenção: pedido encerrado (aceito, recusado, cancelado ou vencido) há mais de 30
 * dias é apagado; a conexão que ele originou fica, com `request_id` nulo. Um aceite em andamento
 * trava a linha: o UPDATE espera e, depois do commit, não encontra mais o pendente.
 */
export async function closeConnectionRequests(db: Database, now: Date) {
  const expired = await db
    .update(connectionRequests)
    .set({ status: 'expired', respondedAt: now })
    .where(and(eq(connectionRequests.status, 'pending'), lte(connectionRequests.expiresAt, now)))
    .returning({ id: connectionRequests.id });
  const cutoff = new Date(now.getTime() - CONNECTION_REQUEST_RETENTION_DAYS * DAY_MS);
  const deleted = await db
    .delete(connectionRequests)
    .where(and(ne(connectionRequests.status, 'pending'), lt(connectionRequests.createdAt, cutoff)))
    .returning({ id: connectionRequests.id });
  return { expired: expired.length, deleted: deleted.length };
}

/**
 * Uma rodada da manutenção: hard delete, tokens vencidos, a limpeza da 2.11, (Fase 4) os pedidos
 * de conexão vencidos e antigos e (Fase 6) a retenção das notificações e dos push tokens.
 */
export async function runMaintenance(
  db: Database,
  storage: ObjectStorage,
  options: MaintenanceOptions,
): Promise<MaintenanceResult> {
  const cutoff = new Date(options.now.getTime() - options.purgeAfterDays * DAY_MS);
  const purged = await purgeDeletedAccounts(db, storage, cutoff);
  const expired = await deleteExpiredTokens(db, options.now);
  const requests = await closeConnectionRequests(db, options.now);
  const retention = await purgeNotificationsAndPushTokens(db, options.now);
  const cleanup = await runCleanup(db, storage, {
    now: options.now,
    draftTtlHours: options.draftTtlHours,
    processingTimeoutMin: options.processingTimeoutMin,
  });
  return {
    ...cleanup,
    purgedAccounts: purged.accounts,
    purgedObjects: purged.objects,
    recalculatedPosts: purged.recalculatedPosts,
    deletedRefreshTokens: expired.refresh,
    deletedEmailTokens: expired.email,
    expiredConnectionRequests: requests.expired,
    deletedConnectionRequests: requests.deleted,
    deletedNotifications: retention.notifications,
    deletedPushTokens: retention.pushTokens,
  };
}
