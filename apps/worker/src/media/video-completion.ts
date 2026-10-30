import { Logger } from '@nestjs/common';
import type { Database } from '@sussurro/db';

import { PermanentMediaError } from './image-processor.js';
import { markPostMediaFailed, markPostMediaReady } from './post-media-state.js';
import { assertReelDuration, type VideoCompletion } from './video-processor.js';
import type { Clock } from '../infra/clock.js';
import { describeError } from '../infra/describe-error.js';
import type { ObjectStorage } from '../infra/storage.js';

/** O que o fim do processamento precisa saber do vídeo. */
export interface VideoMediaRef {
  id: string;
  postId: string;
  incomingKey: string;
  posterIncomingKey: string | null;
}

/**
 * Aplica o fim do processamento de um vídeo (passthrough na hora; MediaConvert pelo evento da
 * `video-events`), ADR 0006:
 * - pronto: confere de novo a duração medida (até 90 s, D10) e as saídas, marca a mídia `ready` e
 *   publica o post (o reel aparece no feed e no perfil de quem pode ver);
 * - com falha (ou recusado aqui): mídia e post `failed`, só o autor vê (MID-10), e as saídas que
 *   chegaram a ser gravadas são apagadas;
 * - nos dois casos, o original e o poster em `incoming/` são apagados (ADR 0006: o original com a
 *   localização não fica guardado).
 * Idempotente: só muda mídia em `processing`.
 */
export class VideoFinisher {
  private readonly logger = new Logger(VideoFinisher.name);

  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
  ) {}

  async finish(media: VideoMediaRef, completion: VideoCompletion): Promise<'ready' | 'failed'> {
    const now = this.clock.now();
    let result: 'ready' | 'failed';
    const ready = completion.status === 'ready' ? this.readyOutput(completion) : null;
    if (ready !== null && !(ready instanceof PermanentMediaError)) {
      await markPostMediaReady(this.db, now, media, ready);
      result = 'ready';
    } else {
      const reason =
        ready instanceof PermanentMediaError
          ? ready.message
          : (completion.error ?? 'Falha no processamento do vídeo');
      await markPostMediaFailed(this.db, now, media, reason);
      await this.deleteQuietly(completion.outputKeys ?? []);
      this.logger.warn(`Vídeo ${media.id} do post ${media.postId} falhou: ${reason}`);
      result = 'failed';
    }
    await this.deleteQuietly(
      [media.incomingKey, media.posterIncomingKey].filter((key): key is string => key !== null),
    );
    return result;
  }

  /** Saídas e medidas do vídeo pronto, ou o motivo de recusar (duração acima de 90 s, sem saída). */
  private readyOutput(completion: VideoCompletion) {
    try {
      const durationS = assertReelDuration(completion.durationS);
      if (
        completion.outputKey === undefined ||
        completion.posterKey === undefined ||
        completion.width === undefined ||
        completion.height === undefined ||
        completion.width <= 0 ||
        completion.height <= 0
      ) {
        return new PermanentMediaError('Saída do vídeo incompleta');
      }
      return {
        storageKey: completion.outputKey,
        thumbKey: completion.posterKey,
        width: Math.round(completion.width),
        height: Math.round(completion.height),
        durationS,
      };
    } catch (error) {
      if (error instanceof PermanentMediaError) {
        return error;
      }
      throw error;
    }
  }

  async deleteQuietly(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    try {
      await this.storage.deleteObjects(keys);
    } catch (error) {
      this.logger.warn(`Falha ao apagar ${keys.join(', ')}: ${describeError(error)}`);
    }
  }
}
