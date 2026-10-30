import { Logger } from '@nestjs/common';
import { and, type Database, eq, postMedia } from '@sussurro/db';

import type { JobOutcome } from './media-job.handler.js';
import { VideoFinisher } from './video-completion.js';
import type { VideoProcessor } from './video-processor.js';
import type { Clock } from '../infra/clock.js';
import type { ObjectStorage } from '../infra/storage.js';

/**
 * Eventos de fim de job do MediaConvert (fila `video-events`, EventBridge → SQS; ADR 0006, história
 * 5.2):
 * - evento de outro app, de outro serviço, de um estado intermediário ou de um job desconhecido
 *   (nenhuma mídia com aquele `mediaId` **e** aquele id de job) → descartado sem efeito (CA3);
 * - `COMPLETE` → mídia `ready`, post `published` e o original apagado de `incoming/` (CA2);
 * - `ERROR` → mídia e post `failed` (só o autor vê, MID-10) e o original apagado;
 * - repetido → nada muda (só mídia em `processing` muda). Um `COMPLETE` que chega depois de a mídia
 *   ter falhado (tempo esgotado) só apaga as saídas, que nunca serão servidas.
 */
export class VideoEventsHandler {
  private readonly logger = new Logger(VideoEventsHandler.name);
  private readonly finisher: VideoFinisher;

  constructor(
    private readonly db: Database,
    storage: ObjectStorage,
    clock: Clock,
    private readonly video: VideoProcessor,
  ) {
    this.finisher = new VideoFinisher(db, storage, clock);
  }

  async handle(event: unknown): Promise<JobOutcome> {
    const completion = this.video.parseCompletion(event);
    if (completion === null) {
      this.logger.debug('Evento da video-events de outro app ou estado: descartado');
      return 'done';
    }
    const [media] = await this.db
      .select({
        id: postMedia.id,
        postId: postMedia.postId,
        incomingKey: postMedia.incomingKey,
        posterIncomingKey: postMedia.posterIncomingKey,
        status: postMedia.status,
      })
      .from(postMedia)
      .where(
        and(
          eq(postMedia.id, completion.mediaId),
          eq(postMedia.kind, 'video'),
          eq(postMedia.processorJobId, completion.jobId),
        ),
      )
      .limit(1);
    if (media === undefined) {
      this.logger.warn(`Evento de um job desconhecido (${completion.jobId}): descartado`);
      return 'done';
    }
    if (media.status === 'processing') {
      await this.finisher.finish(media, completion);
    } else if (media.status === 'failed' && completion.status === 'ready') {
      await this.finisher.deleteQuietly(completion.outputKeys ?? []);
    }
    return 'done';
  }
}
