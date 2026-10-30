import { and, type Database, eq, ne, postMedia, posts } from '@sussurro/db';

/** Saídas de uma mídia pronta (imagem: `full`/`thumb`; vídeo: MP4/poster, com a duração). */
export interface ReadyMediaOutput {
  storageKey: string;
  thumbKey: string;
  width: number;
  height: number;
  durationS?: number;
}

/**
 * Marca a mídia `ready` e, se for a última do post, publica o post (`published_at` = agora). O post
 * é travado (`FOR UPDATE`): duas imagens terminando juntas não deixam o post sem publicar. Só muda
 * mídia em `processing` (idempotente: repetir não faz nada). Devolve se a mídia mudou.
 */
export async function markPostMediaReady(
  db: Database,
  now: Date,
  media: { id: string; postId: string },
  output: ReadyMediaOutput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.select({ id: posts.id }).from(posts).where(eq(posts.id, media.postId)).for('update');
    const updated = await tx
      .update(postMedia)
      .set({
        status: 'ready',
        storageKey: output.storageKey,
        thumbKey: output.thumbKey,
        width: output.width,
        height: output.height,
        ...(output.durationS === undefined ? {} : { durationS: output.durationS }),
        error: null,
        updatedAt: now,
      })
      .where(and(eq(postMedia.id, media.id), eq(postMedia.status, 'processing')))
      .returning({ id: postMedia.id });
    const pending = await tx
      .select({ id: postMedia.id })
      .from(postMedia)
      .where(and(eq(postMedia.postId, media.postId), ne(postMedia.status, 'ready')))
      .limit(1);
    if (pending.length === 0) {
      await tx
        .update(posts)
        .set({ status: 'published', publishedAt: now })
        .where(and(eq(posts.id, media.postId), eq(posts.status, 'processing')));
    }
    return updated.length > 0;
  });
}

/**
 * Uma mídia com falha deixa o post inteiro `failed` (MID-10): ninguém além do autor o vê, e ele
 * aparece no perfil do autor com "Tentar de novo" e "Excluir" (5.6). Idempotente.
 */
export async function markPostMediaFailed(
  db: Database,
  now: Date,
  media: { id: string; postId: string },
  reason: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.select({ id: posts.id }).from(posts).where(eq(posts.id, media.postId)).for('update');
    const updated = await tx
      .update(postMedia)
      .set({ status: 'failed', error: reason.slice(0, 500), updatedAt: now })
      .where(and(eq(postMedia.id, media.id), eq(postMedia.status, 'processing')))
      .returning({ id: postMedia.id });
    await tx
      .update(posts)
      .set({ status: 'failed' })
      .where(and(eq(posts.id, media.postId), eq(posts.status, 'processing')));
    return updated.length > 0;
  });
}
