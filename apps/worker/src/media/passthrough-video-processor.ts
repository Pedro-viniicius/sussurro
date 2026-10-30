import { MAX_POSTER_BYTES } from '@sussurro/shared';

import { type ImageLimits, PermanentMediaError, processPosterImage } from './image-processor.js';
import {
  inspectStoredVideo,
  type VideoCompletion,
  VideoProcessor,
  type VideoSource,
  type VideoSubmission,
  videoOutputKeys,
} from './video-processor.js';
import type { ObjectStorage } from '../infra/storage.js';

/**
 * `VIDEO_PROCESSOR=passthrough` (ADR 0006, história 5.1): o processador de desenvolvimento e dos
 * testes, porque o MediaConvert não tem emulação gratuita. Confere o vídeo (magic bytes e até 90 s),
 * copia o original para `media/{id}/video.mp4` dentro do S3 e usa o poster enviado pelo app, que
 * passa pelo pipeline das fotos (sem nenhum metadado). Termina na hora (`completion` pronto).
 *
 * **O vídeo sai com os metadados do original, inclusive a localização** (A-21): por isso o worker
 * recusa o passthrough em produção, e em dev só se usam vídeos de teste sem localização (5.2 CA4).
 */
export class PassthroughVideoProcessor extends VideoProcessor {
  readonly name = 'passthrough' as const;
  readonly usesUploadedPoster = true;

  constructor(
    private readonly storage: ObjectStorage,
    private readonly limits: ImageLimits,
  ) {
    super();
  }

  async submit(source: VideoSource): Promise<VideoSubmission> {
    const probe = await inspectStoredVideo(this.storage, source.sourceKey);
    const posterInput = await this.storage.get(source.posterSourceKey, MAX_POSTER_BYTES + 1024);
    if (posterInput === null) {
      throw new PermanentMediaError('O poster não está em incoming/');
    }
    const poster = await processPosterImage(posterInput, source.posterMime, this.limits);
    const keys = videoOutputKeys(source.mediaId);
    await this.storage.copy(
      source.sourceKey,
      keys.video,
      probe.container === 'quicktime' ? 'video/quicktime' : 'video/mp4',
    );
    await this.storage.put(keys.poster, poster.data, 'image/jpeg');
    const jobId = `passthrough:${source.mediaId}`;
    return {
      jobId,
      completion: {
        mediaId: source.mediaId,
        jobId,
        status: 'ready',
        outputKey: keys.video,
        posterKey: keys.poster,
        durationS: probe.durationS,
        width: probe.width,
        height: probe.height,
        outputKeys: [keys.video, keys.poster],
      },
    };
  }

  /** O passthrough não tem eventos: tudo o que chega na `video-events` é descartado. */
  parseCompletion(): VideoCompletion | null {
    return null;
  }
}
