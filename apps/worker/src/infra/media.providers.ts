import { MediaConvertClient } from '@aws-sdk/client-mediaconvert';
import type { Provider } from '@nestjs/common';
import type { DbHandle } from '@sussurro/db';

import { Clock, SystemClock } from './clock.js';
import { DATABASE } from './connections.js';
import { createSqsClient, MessageQueue, SqsMessageQueue } from './queue.js';
import { createS3Client, ObjectStorage, S3ObjectStorage } from './storage.js';
import { WorkerConfig } from '../config/config.module.js';
import type { WorkerEnv } from '../config/env.schema.js';
import { MediaJobHandler } from '../media/media-job.handler.js';
import { MediaJobsConsumer } from '../media/media-jobs.consumer.js';
import {
  type MediaConvertSender,
  MediaConvertVideoProcessor,
} from '../media/mediaconvert-video-processor.js';
import { PassthroughVideoProcessor } from '../media/passthrough-video-processor.js';
import { VideoEventsConsumer } from '../media/video-events.consumer.js';
import { VideoEventsHandler } from '../media/video-events.handler.js';
import { VideoProcessor } from '../media/video-processor.js';

/** Fila `video-events` (Fase 5): o mesmo contrato da `media-jobs`, outra fila. */
export const VIDEO_EVENTS_QUEUE = Symbol('VIDEO_EVENTS_QUEUE');

/**
 * Escolhe o `VideoProcessor` pelo `VIDEO_PROCESSOR` (5.1 CA1: trocar não muda código). O cliente
 * do MediaConvert usa o endpoint regional padrão do SDK e as credenciais da task (IAM role).
 */
export function createVideoProcessor(
  env: Pick<
    WorkerEnv,
    | 'VIDEO_PROCESSOR'
    | 'MEDIA_MAX_INPUT_PIXELS'
    | 'AWS_REGION'
    | 'S3_BUCKET_MEDIA'
    | 'MEDIACONVERT_ROLE_ARN'
    | 'MEDIACONVERT_QUEUE_ARN'
  >,
  storage: ObjectStorage,
  mediaConvert?: MediaConvertSender,
): VideoProcessor {
  if (env.VIDEO_PROCESSOR === 'passthrough') {
    return new PassthroughVideoProcessor(storage, { maxPixels: env.MEDIA_MAX_INPUT_PIXELS });
  }
  if (env.MEDIACONVERT_ROLE_ARN === undefined) {
    throw new Error('MEDIACONVERT_ROLE_ARN é obrigatória com VIDEO_PROCESSOR=mediaconvert');
  }
  return new MediaConvertVideoProcessor(
    mediaConvert ?? new MediaConvertClient({ region: env.AWS_REGION, maxAttempts: 3 }),
    storage,
    {
      bucket: env.S3_BUCKET_MEDIA,
      roleArn: env.MEDIACONVERT_ROLE_ARN,
      queueArn: env.MEDIACONVERT_QUEUE_ARN,
    },
  );
}

/**
 * Providers do pipeline de mídia (ADR 0009 e, na Fase 5, ADR 0006). S3 e SQS só mudam pelo `.env`
 * (SeaweedFS/ElasticMQ em dev, AWS em produção); os testes trocam `ObjectStorage`, `MessageQueue`,
 * `VIDEO_EVENTS_QUEUE` e `VideoProcessor` pelos fakes.
 */
export const mediaProviders: Provider[] = [
  { provide: Clock, useClass: SystemClock },
  {
    provide: ObjectStorage,
    inject: [WorkerConfig],
    useFactory: ({ env }: WorkerConfig): ObjectStorage =>
      new S3ObjectStorage(
        createS3Client({
          region: env.AWS_REGION,
          bucket: env.S3_BUCKET_MEDIA,
          endpoint: env.AWS_ENDPOINT_URL_S3,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
        }),
        env.S3_BUCKET_MEDIA,
      ),
  },
  {
    provide: MessageQueue,
    inject: [WorkerConfig],
    useFactory: ({ env }: WorkerConfig): MessageQueue =>
      new SqsMessageQueue(
        createSqsClient({
          region: env.AWS_REGION,
          endpoint: env.AWS_ENDPOINT_URL_SQS,
          queueName: env.SQS_QUEUE_MEDIA_JOBS,
        }),
        env.SQS_QUEUE_MEDIA_JOBS,
      ),
  },
  {
    // Só com o MediaConvert: o passthrough não tem eventos.
    provide: VIDEO_EVENTS_QUEUE,
    inject: [WorkerConfig],
    useFactory: ({ env }: WorkerConfig): MessageQueue | null =>
      env.VIDEO_PROCESSOR === 'mediaconvert'
        ? new SqsMessageQueue(
            createSqsClient({
              region: env.AWS_REGION,
              endpoint: env.AWS_ENDPOINT_URL_SQS,
              queueName: env.SQS_QUEUE_VIDEO_EVENTS,
            }),
            env.SQS_QUEUE_VIDEO_EVENTS,
          )
        : null,
  },
  {
    provide: VideoProcessor,
    inject: [WorkerConfig, ObjectStorage],
    useFactory: ({ env }: WorkerConfig, storage: ObjectStorage) =>
      createVideoProcessor(env, storage),
  },
  {
    provide: MediaJobHandler,
    inject: [DATABASE, ObjectStorage, Clock, WorkerConfig, VideoProcessor],
    useFactory: (
      database: DbHandle,
      storage: ObjectStorage,
      clock: Clock,
      { env }: WorkerConfig,
      video: VideoProcessor,
    ) =>
      new MediaJobHandler(
        database.db,
        storage,
        clock,
        { maxPixels: env.MEDIA_MAX_INPUT_PIXELS },
        video,
      ),
  },
  {
    provide: MediaJobsConsumer,
    inject: [MessageQueue, MediaJobHandler, WorkerConfig],
    useFactory: (queue: MessageQueue, handler: MediaJobHandler, { env }: WorkerConfig) =>
      new MediaJobsConsumer(queue, handler, {
        concurrency: env.MEDIA_JOBS_CONCURRENCY,
        waitTimeSeconds: env.MEDIA_JOBS_WAIT_S,
        maxAttempts: env.MEDIA_JOBS_MAX_ATTEMPTS,
      }),
  },
  {
    provide: VideoEventsConsumer,
    inject: [VIDEO_EVENTS_QUEUE, DATABASE, ObjectStorage, Clock, VideoProcessor, WorkerConfig],
    useFactory: (
      queue: MessageQueue | null,
      database: DbHandle,
      storage: ObjectStorage,
      clock: Clock,
      video: VideoProcessor,
      { env }: WorkerConfig,
    ): VideoEventsConsumer | null =>
      queue === null || env.VIDEO_PROCESSOR !== 'mediaconvert'
        ? null
        : new VideoEventsConsumer(
            queue,
            new VideoEventsHandler(database.db, storage, clock, video),
            {
              concurrency: env.MEDIA_JOBS_CONCURRENCY,
              waitTimeSeconds: env.MEDIA_JOBS_WAIT_S,
              maxAttempts: env.MEDIA_JOBS_MAX_ATTEMPTS,
            },
          ),
  },
];
