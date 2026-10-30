import { Global, Module } from '@nestjs/common';

import { CloudFrontMediaUrlSigner } from './cloudfront-url-signer.js';
import { createSqsClient, MediaJobsQueue, SqsMediaJobsQueue } from './media-jobs-queue.js';
import { MediaUrlSigner, ObjectStorage } from './object-storage.js';
import { PushQueue, SqsPushQueue } from './push-queue.js';
import { createS3Clients, S3ObjectStorage, S3PresignMediaUrlSigner } from './s3-object-storage.js';
import { AppConfig } from '../../config/config.module.js';
import { Tracing } from '../observability/tracing.js';

/** Clientes S3 (interno e público), criados uma vez e compartilhados pelos providers. */
const S3_CLIENTS = Symbol('S3_CLIENTS');

/**
 * Infra de mídia (ADR 0009, 0010): S3 (HEAD, Delete e presign), fila `media-jobs` e assinador das
 * URLs de leitura. Só configuração: trocar SeaweedFS/ElasticMQ pela AWS é mudar o `.env`. Os
 * clientes do SDK não abrem conexão até o primeiro uso. (Fase 6) Também a fila `push` (ADR 0011).
 */
@Global()
@Module({
  providers: [
    {
      provide: S3_CLIENTS,
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) =>
        createS3Clients({
          region: env.AWS_REGION,
          bucket: env.S3_BUCKET_MEDIA,
          endpoint: env.AWS_ENDPOINT_URL_S3,
          publicEndpoint: env.S3_PUBLIC_ENDPOINT_URL,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
        }),
    },
    {
      provide: ObjectStorage,
      inject: [S3_CLIENTS, AppConfig],
      useFactory: (clients: ReturnType<typeof createS3Clients>, { env }: AppConfig) =>
        new S3ObjectStorage(clients, env.S3_BUCKET_MEDIA),
    },
    {
      provide: MediaUrlSigner,
      inject: [S3_CLIENTS, AppConfig],
      useFactory: (
        clients: ReturnType<typeof createS3Clients>,
        { env }: AppConfig,
      ): MediaUrlSigner => {
        switch (env.MEDIA_URL_SIGNER) {
          case 'cloudfront':
            // O schema do env garante as três variáveis com MEDIA_URL_SIGNER=cloudfront.
            return new CloudFrontMediaUrlSigner({
              domain: env.CLOUDFRONT_DOMAIN ?? '',
              keyPairId: env.CLOUDFRONT_KEY_PAIR_ID ?? '',
              privateKey: env.CLOUDFRONT_PRIVATE_KEY ?? '',
            });
          case 's3-presign':
            return new S3PresignMediaUrlSigner(clients.public, env.S3_BUCKET_MEDIA);
        }
      },
    },
    {
      provide: MediaJobsQueue,
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) =>
        new SqsMediaJobsQueue(
          createSqsClient({
            region: env.AWS_REGION,
            endpoint: env.AWS_ENDPOINT_URL_SQS,
            queueName: env.SQS_QUEUE_MEDIA_JOBS,
          }),
          env.SQS_QUEUE_MEDIA_JOBS,
        ),
    },
    {
      provide: PushQueue,
      inject: [AppConfig, Tracing],
      useFactory: ({ env }: AppConfig, tracing: Tracing) =>
        new SqsPushQueue(
          createSqsClient({
            region: env.AWS_REGION,
            endpoint: env.AWS_ENDPOINT_URL_SQS,
            queueName: env.SQS_QUEUE_PUSH,
          }),
          env.SQS_QUEUE_PUSH,
          tracing,
        ),
    },
  ],
  exports: [ObjectStorage, MediaUrlSigner, MediaJobsQueue, PushQueue],
})
export class StorageModule {}
