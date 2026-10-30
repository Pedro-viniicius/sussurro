import { Logger } from '@nestjs/common';
import {
  and,
  avatarUploads,
  type Database,
  eq,
  gt,
  inArray,
  isNull,
  postMedia,
  users,
} from '@sussurro/db';
import { MAX_IMAGE_BYTES, type MediaJobMessage } from '@sussurro/shared';

import {
  type ImageLimits,
  PermanentMediaError,
  processAvatarImage,
  processPostImage,
} from './image-processor.js';
import { markPostMediaFailed, markPostMediaReady } from './post-media-state.js';
import { VideoFinisher } from './video-completion.js';
import type { VideoProcessor } from './video-processor.js';
import type { Clock } from '../infra/clock.js';
import { describeError } from '../infra/describe-error.js';
import { type ObjectStorage, ObjectTooLargeError } from '../infra/storage.js';

/**
 * Resultado do processamento de uma mensagem:
 * - `done`: terminou (com sucesso, com falha definitiva ou porque não havia nada a fazer): apagar;
 * - `retry`: falha transitória; a mensagem volta depois do visibility timeout;
 * - `dead`: última tentativa falhou; a mídia ficou `failed` e a mensagem segue para a DLQ.
 */
export type JobOutcome = 'done' | 'retry' | 'dead';

export interface JobAttempt {
  /** Entrega atual (1 na primeira). */
  attempt: number;
  maxAttempts: number;
}

/** Chaves de saída no S3 (servidas pelo CloudFront, só `media/*`). */
export function postMediaKeys(mediaId: string) {
  return { full: `media/${mediaId}/full.jpg`, thumb: `media/${mediaId}/thumb.jpg` };
}

export function avatarKey(uploadId: string): string {
  return `media/${uploadId}/avatar.jpg`;
}

/** Folga sobre os 15 MB assinados (o S3 já recusou corpo maior; aqui é defesa em profundidade). */
const MAX_INPUT_BYTES = MAX_IMAGE_BYTES + 1024;

/**
 * Processa uma mensagem da fila `media-jobs` (ADR 0009, história 2.3): lê o original em
 * `incoming/`, confere os magic bytes, gira pela orientação, remove todos os metadados, grava
 * `full` e `thumb` em `media/`, marca a mídia `ready` e publica o post quando todas estão prontas.
 * (Fase 5, ADR 0006) O vídeo do reel (`post-video`) vai para o `VideoProcessor`: o passthrough
 * termina na hora; o MediaConvert só guarda o id do job, e o fim chega pela fila `video-events`.
 * Idempotente: mídia que não está em `processing` (duplicata, post revertido) é ignorada.
 */
export class MediaJobHandler {
  private readonly logger = new Logger(MediaJobHandler.name);
  private readonly finisher: VideoFinisher;

  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
    private readonly limits: ImageLimits,
    private readonly video: VideoProcessor,
  ) {
    this.finisher = new VideoFinisher(db, storage, clock);
  }

  async handle(message: MediaJobMessage, attempt: JobAttempt): Promise<JobOutcome> {
    switch (message.type) {
      case 'post-media':
        return this.handlePostMedia(message.mediaId, attempt);
      case 'avatar':
        return this.handleAvatar(message.uploadId, attempt);
      case 'post-video':
        return this.handlePostVideo(message.mediaId, attempt);
    }
  }

  /** Falha definitiva marca na hora; transitória só na última tentativa (MID-10). */
  private async onFailure(
    error: unknown,
    attempt: JobAttempt,
    markFailed: (reason: string) => Promise<void>,
    incomingKeys: string | readonly string[],
  ): Promise<JobOutcome> {
    const permanent = error instanceof PermanentMediaError || error instanceof ObjectTooLargeError;
    if (permanent) {
      await markFailed(error.message);
      await this.deleteQuietly(typeof incomingKeys === 'string' ? [incomingKeys] : incomingKeys);
      return 'done';
    }
    if (attempt.attempt >= attempt.maxAttempts) {
      await markFailed(
        `Falhou depois de ${String(attempt.maxAttempts)} tentativas: ${describeError(error)}`,
      );
      return 'dead';
    }
    this.logger.warn(
      `Tentativa ${String(attempt.attempt)}/${String(attempt.maxAttempts)} falhou: ${describeError(error)}`,
    );
    return 'retry';
  }

  private async deleteQuietly(keys: readonly string[]): Promise<void> {
    try {
      await this.storage.deleteObjects(keys);
    } catch (error) {
      this.logger.warn(`Falha ao apagar ${keys.join(', ')}: ${describeError(error)}`);
    }
  }

  private async handlePostMedia(mediaId: string, attempt: JobAttempt): Promise<JobOutcome> {
    const [media] = await this.db
      .select({
        id: postMedia.id,
        postId: postMedia.postId,
        mime: postMedia.mime,
        incomingKey: postMedia.incomingKey,
        status: postMedia.status,
      })
      .from(postMedia)
      .where(eq(postMedia.id, mediaId))
      .limit(1);
    if (media?.status !== 'processing') {
      return 'done';
    }
    try {
      const input = await this.storage.get(media.incomingKey, MAX_INPUT_BYTES);
      if (input === null) {
        throw new PermanentMediaError('O original não está em incoming/');
      }
      const { full, thumb } = await processPostImage(input, media.mime, this.limits);
      const keys = postMediaKeys(media.id);
      await this.storage.put(keys.full, full.data, 'image/jpeg');
      await this.storage.put(keys.thumb, thumb.data, 'image/jpeg');
      await markPostMediaReady(this.db, this.clock.now(), media, {
        storageKey: keys.full,
        thumbKey: keys.thumb,
        width: full.width,
        height: full.height,
      });
      await this.deleteQuietly([media.incomingKey]);
      return 'done';
    } catch (error) {
      return this.onFailure(
        error,
        attempt,
        async (reason) => {
          // 1 de N imagens falhou → o post inteiro fica `failed` (MID-10).
          await markPostMediaFailed(this.db, this.clock.now(), media, reason);
          this.logger.warn(`Imagem ${media.id} do post ${media.postId} falhou: ${reason}`);
        },
        media.incomingKey,
      );
    }
  }

  /**
   * Vídeo do reel (ADR 0006, 5.1 e 5.2): entrega ao `VideoProcessor`. O passthrough termina aqui
   * (mídia `ready` e post publicado, ou `failed`); o MediaConvert grava o id do job e o post continua
   * `processing` até o evento da `video-events`. Uma mensagem repetida depois de o job ser criado
   * não cria outro (o id já está gravado; o `ClientRequestToken` cobre a corrida de 1 min).
   */
  private async handlePostVideo(mediaId: string, attempt: JobAttempt): Promise<JobOutcome> {
    const [media] = await this.db
      .select({
        id: postMedia.id,
        postId: postMedia.postId,
        kind: postMedia.kind,
        incomingKey: postMedia.incomingKey,
        posterIncomingKey: postMedia.posterIncomingKey,
        posterMime: postMedia.posterMime,
        status: postMedia.status,
        processorJobId: postMedia.processorJobId,
      })
      .from(postMedia)
      .where(eq(postMedia.id, mediaId))
      .limit(1);
    if (media?.status !== 'processing' || media.kind !== 'video' || media.processorJobId !== null) {
      return 'done';
    }
    const incoming = [media.incomingKey, media.posterIncomingKey].filter(
      (key): key is string => key !== null,
    );
    try {
      if (media.posterIncomingKey === null || media.posterMime === null) {
        throw new PermanentMediaError('Reel sem poster');
      }
      const submission = await this.video.submit({
        mediaId: media.id,
        sourceKey: media.incomingKey,
        posterSourceKey: media.posterIncomingKey,
        posterMime: media.posterMime,
      });
      if (submission.completion !== null) {
        await this.finisher.finish(media, submission.completion);
        return 'done';
      }
      await this.db
        .update(postMedia)
        .set({ processorJobId: submission.jobId, updatedAt: this.clock.now() })
        .where(
          and(
            eq(postMedia.id, media.id),
            eq(postMedia.status, 'processing'),
            isNull(postMedia.processorJobId),
          ),
        );
      if (!this.video.usesUploadedPoster) {
        // O MediaConvert gera o próprio poster: o do app não fica guardado.
        await this.deleteQuietly([media.posterIncomingKey]);
      }
      return 'done';
    } catch (error) {
      return this.onFailure(
        error,
        attempt,
        async (reason) => {
          await markPostMediaFailed(this.db, this.clock.now(), media, reason);
          this.logger.warn(`Vídeo ${media.id} do post ${media.postId} falhou: ${reason}`);
        },
        incoming,
      );
    }
  }

  private async handleAvatar(uploadId: string, attempt: JobAttempt): Promise<JobOutcome> {
    const [upload] = await this.db
      .select()
      .from(avatarUploads)
      .where(eq(avatarUploads.id, uploadId))
      .limit(1);
    if (upload?.status !== 'processing') {
      return 'done';
    }
    try {
      const input = await this.storage.get(upload.incomingKey, MAX_INPUT_BYTES);
      if (input === null) {
        throw new PermanentMediaError('O original não está em incoming/');
      }
      const output = await processAvatarImage(input, upload.mime, this.limits);
      const key = avatarKey(upload.id);
      await this.storage.put(key, output.data, 'image/jpeg');
      const { applied, previousKey } = await this.applyAvatar(upload, key);
      const stale = [upload.incomingKey];
      if (!applied) {
        stale.push(key);
      } else if (previousKey !== null && previousKey !== key) {
        stale.push(previousKey);
      }
      await this.deleteQuietly(stale);
      return 'done';
    } catch (error) {
      return this.onFailure(
        error,
        attempt,
        async (reason) => {
          await this.db
            .update(avatarUploads)
            .set({ status: 'failed', error: reason.slice(0, 500), updatedAt: this.clock.now() })
            .where(and(eq(avatarUploads.id, upload.id), eq(avatarUploads.status, 'processing')));
        },
        upload.incomingKey,
      );
    }
  }

  /**
   * Troca a foto se esta for a troca mais recente pedida (o app pode ter pedido outra depois) e a
   * conta continuar ativa. A linha do usuário fica travada durante a troca.
   */
  private async applyAvatar(
    upload: { id: string; userId: string; requestedAt: Date | null },
    key: string,
  ): Promise<{ applied: boolean; previousKey: string | null }> {
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .select({ avatarKey: users.avatarKey, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, upload.userId))
        .for('update');
      await tx
        .update(avatarUploads)
        .set({ status: 'ready', storageKey: key, error: null, updatedAt: now })
        .where(eq(avatarUploads.id, upload.id));
      const newer =
        upload.requestedAt === null
          ? []
          : await tx
              .select({ id: avatarUploads.id })
              .from(avatarUploads)
              .where(
                and(
                  eq(avatarUploads.userId, upload.userId),
                  inArray(avatarUploads.status, ['processing', 'ready']),
                  gt(avatarUploads.requestedAt, upload.requestedAt),
                ),
              )
              .limit(1);
      if (user?.deletedAt !== null || newer.length > 0) {
        return { applied: false, previousKey: null };
      }
      await tx
        .update(users)
        .set({ avatarKey: key, updatedAt: now })
        .where(eq(users.id, upload.userId));
      return { applied: true, previousKey: user.avatarKey };
    });
  }
}
