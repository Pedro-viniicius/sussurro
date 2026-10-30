import {
  and,
  avatarUploads,
  type Database,
  eq,
  inArray,
  isNotNull,
  lt,
  notExists,
  postMedia,
  posts,
  type SQL,
  users,
} from '@sussurro/db';

import type { ObjectStorage } from '../infra/storage.js';
import { videoOutputKeys } from '../media/video-processor.js';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Linhas por transação: curtas, sem travar as tabelas. */
export const CLEANUP_BATCH_SIZE = 100;

export interface CleanupOptions {
  now: Date;
  /** Rascunhos mais velhos que isto saem com os objetos (2.11 CA1, MID-12). */
  draftTtlHours: number;
  /** Mídia em `processing` há mais que isto vira `failed` (o worker caiu nas tentativas). */
  processingTimeoutMin: number;
  batchSize?: number;
}

export interface CleanupResult {
  drafts: number;
  deletedPosts: number;
  avatarUploads: number;
  stuckMedia: number;
  /** Objetos apagados do S3. */
  objects: number;
}

/** Chaves não nulas e sem repetição. */
export function uniqueKeys(keys: readonly (string | null)[]): string[] {
  return [...new Set(keys.filter((key): key is string => key !== null && key !== ''))];
}

/** Colunas de `post_media` com as chaves de objetos no S3. */
export const postMediaKeyColumns = {
  id: postMedia.id,
  kind: postMedia.kind,
  incoming: postMedia.incomingKey,
  posterIncoming: postMedia.posterIncomingKey,
  storage: postMedia.storageKey,
  thumb: postMedia.thumbKey,
};

/**
 * Todos os objetos de uma mídia: o original em `incoming/`, as saídas gravadas e, no vídeo (Fase 5),
 * o poster enviado pelo app e as saídas previstas do `VideoProcessor` (gravadas antes de uma falha
 * ou de um evento atrasado, sem chave no banco).
 */
export function postMediaObjectKeys(media: {
  id: string;
  kind: 'image' | 'video';
  incoming: string;
  posterIncoming: string | null;
  storage: string | null;
  thumb: string | null;
}): (string | null)[] {
  const keys = [media.incoming, media.storage, media.thumb];
  if (media.kind === 'video') {
    const outputs = videoOutputKeys(media.id);
    keys.push(media.posterIncoming, outputs.video, outputs.poster, outputs.mediaConvertPoster);
  }
  return keys;
}

/**
 * Apaga posts (e os objetos deles) em lotes. Cada lote é uma transação: as linhas são reservadas
 * com `FOR UPDATE SKIP LOCKED` (duas instâncias do worker nunca pegam a mesma linha, 2.11 CA2), os
 * objetos são apagados do S3 e só então as linhas saem; se o S3 falhar, nada é apagado e o próximo
 * ciclo tenta de novo. Curtidas, comentários e mídia caem em cascata.
 */
async function purgePosts(
  db: Database,
  storage: ObjectStorage,
  where: SQL | undefined,
  batchSize: number,
): Promise<{ posts: number; objects: number }> {
  const total = { posts: 0, objects: 0 };
  for (;;) {
    const batch = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: posts.id })
        .from(posts)
        .where(where)
        .orderBy(posts.createdAt)
        .limit(batchSize)
        .for('update', { skipLocked: true });
      if (rows.length === 0) {
        return { posts: 0, objects: 0 };
      }
      const ids = rows.map((row) => row.id);
      const media = await tx
        .select(postMediaKeyColumns)
        .from(postMedia)
        .where(inArray(postMedia.postId, ids));
      const keys = uniqueKeys(media.flatMap(postMediaObjectKeys));
      if (keys.length > 0) {
        await storage.deleteObjects(keys);
      }
      await tx.delete(posts).where(inArray(posts.id, ids));
      return { posts: ids.length, objects: keys.length };
    });
    total.posts += batch.posts;
    total.objects += batch.objects;
    if (batch.posts < batchSize) {
      return total;
    }
  }
}

/** Rascunhos abandonados há mais de `draftTtlHours` (MID-12): o app nunca chamou o publish. */
export function purgeStaleDrafts(
  db: Database,
  storage: ObjectStorage,
  cutoff: Date,
  batchSize = CLEANUP_BATCH_SIZE,
) {
  return purgePosts(
    db,
    storage,
    and(eq(posts.status, 'draft'), lt(posts.createdAt, cutoff)),
    batchSize,
  );
}

/**
 * Posts apagados pelo autor (2.9 CA3, MID-11): objetos de `media/` e a linha. (Fase 5) Um reel
 * apagado com o job do MediaConvert ainda rodando espera o evento (ou o tempo esgotado): sem a
 * linha, as saídas que o MediaConvert gravasse depois ficariam órfãs no S3.
 */
export function purgeDeletedPosts(
  db: Database,
  storage: ObjectStorage,
  batchSize = CLEANUP_BATCH_SIZE,
) {
  const videoJobRunning = db
    .select({ id: postMedia.id })
    .from(postMedia)
    .where(
      and(
        eq(postMedia.postId, posts.id),
        eq(postMedia.status, 'processing'),
        isNotNull(postMedia.processorJobId),
      ),
    );
  return purgePosts(
    db,
    storage,
    and(isNotNull(posts.deletedAt), notExists(videoJobRunning)),
    batchSize,
  );
}

/**
 * Trocas de avatar com mais de `cutoff`: apaga o original em `incoming/` e as saídas que não são a
 * foto atual da conta (uploads abandonados, com falha ou substituídos), e a linha.
 */
export async function purgeAvatarUploads(
  db: Database,
  storage: ObjectStorage,
  cutoff: Date,
  batchSize = CLEANUP_BATCH_SIZE,
): Promise<{ uploads: number; objects: number }> {
  const total = { uploads: 0, objects: 0 };
  for (;;) {
    const batch = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: avatarUploads.id,
          incoming: avatarUploads.incomingKey,
          output: avatarUploads.storageKey,
          current: users.avatarKey,
        })
        .from(avatarUploads)
        .innerJoin(users, eq(users.id, avatarUploads.userId))
        .where(lt(avatarUploads.createdAt, cutoff))
        .orderBy(avatarUploads.createdAt)
        .limit(batchSize)
        .for('update', { of: avatarUploads, skipLocked: true });
      if (rows.length === 0) {
        return { uploads: 0, objects: 0 };
      }
      const keys = uniqueKeys(
        rows.flatMap((row) => [row.incoming, row.output === row.current ? null : row.output]),
      );
      if (keys.length > 0) {
        await storage.deleteObjects(keys);
      }
      await tx.delete(avatarUploads).where(
        inArray(
          avatarUploads.id,
          rows.map((row) => row.id),
        ),
      );
      return { uploads: rows.length, objects: keys.length };
    });
    total.uploads += batch.uploads;
    total.objects += batch.objects;
    if (batch.uploads < batchSize) {
      return total;
    }
  }
}

/**
 * Rede de segurança do MID-10: se o worker caiu em todas as tentativas (a mensagem foi para a DLQ
 * sem marcar a mídia), a mídia presa em `processing` vira `failed`, e o post também. O app mostra
 * "Não foi possível publicar".
 */
export async function failStuckProcessing(db: Database, cutoff: Date, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const stuck = await tx
      .update(postMedia)
      .set({ status: 'failed', error: 'Tempo de processamento esgotado', updatedAt: now })
      .where(and(eq(postMedia.status, 'processing'), lt(postMedia.updatedAt, cutoff)))
      .returning({ postId: postMedia.postId });
    const postIds = [...new Set(stuck.map((row) => row.postId))];
    if (postIds.length > 0) {
      await tx
        .update(posts)
        .set({ status: 'failed' })
        .where(and(inArray(posts.id, postIds), eq(posts.status, 'processing')));
    }
    const avatars = await tx
      .update(avatarUploads)
      .set({ status: 'failed', error: 'Tempo de processamento esgotado', updatedAt: now })
      .where(and(eq(avatarUploads.status, 'processing'), lt(avatarUploads.updatedAt, cutoff)))
      .returning({ id: avatarUploads.id });
    return stuck.length + avatars.length;
  });
}

/** Todos os jobs de limpeza da história 2.11, numa rodada da manutenção. */
export async function runCleanup(
  db: Database,
  storage: ObjectStorage,
  options: CleanupOptions,
): Promise<CleanupResult> {
  const batchSize = options.batchSize ?? CLEANUP_BATCH_SIZE;
  const draftCutoff = new Date(options.now.getTime() - options.draftTtlHours * HOUR_MS);
  const stuckCutoff = new Date(options.now.getTime() - options.processingTimeoutMin * MINUTE_MS);
  const stuckMedia = await failStuckProcessing(db, stuckCutoff, options.now);
  const drafts = await purgeStaleDrafts(db, storage, draftCutoff, batchSize);
  const deleted = await purgeDeletedPosts(db, storage, batchSize);
  const avatars = await purgeAvatarUploads(db, storage, draftCutoff, batchSize);
  return {
    drafts: drafts.posts,
    deletedPosts: deleted.posts,
    avatarUploads: avatars.uploads,
    stuckMedia,
    objects: drafts.objects + deleted.objects + avatars.objects,
  };
}
