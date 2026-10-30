import type { Provider } from '@nestjs/common';
import type { DbHandle } from '@sussurro/db';
import { Expo } from 'expo-server-sdk';

import { Clock } from './clock.js';
import { DATABASE } from './connections.js';
import { createSqsClient, type MessageQueue, SqsMessageQueue } from './queue.js';
import { Tracing } from './tracing.js';
import { WorkerConfig } from '../config/config.module.js';
import type { WorkerEnv } from '../config/env.schema.js';
import { PushJobHandler } from '../push/push-job.handler.js';
import { ExpoPushSender, LogPushSender, PushSender } from '../push/push-sender.js';
import { PushConsumer } from '../push/push.consumer.js';

/** Fila `push` (Fase 6): o mesmo contrato das outras filas, outra fila. */
export const PUSH_QUEUE = Symbol('PUSH_QUEUE');

/**
 * Escolhe quem envia o push pelo `PUSH_SENDER`: o Expo (com o access token, se houver) ou o log
 * de desenvolvimento. Os testes trocam o `PushSender` por um fake.
 */
export function createPushSender(env: Pick<WorkerEnv, 'PUSH_SENDER' | 'EXPO_ACCESS_TOKEN'>) {
  if (env.PUSH_SENDER === 'log') {
    return new LogPushSender();
  }
  return new ExpoPushSender(
    new Expo(env.EXPO_ACCESS_TOKEN === undefined ? {} : { accessToken: env.EXPO_ACCESS_TOKEN }),
  );
}

/** Providers do push (ADR 0011) e do tracing (6.8). */
export const pushProviders: Provider[] = [
  {
    provide: Tracing,
    inject: [WorkerConfig],
    useFactory: ({ env }: WorkerConfig) => new Tracing(env.OTEL_ENABLED),
  },
  {
    provide: PUSH_QUEUE,
    inject: [WorkerConfig],
    useFactory: ({ env }: WorkerConfig): MessageQueue =>
      new SqsMessageQueue(
        createSqsClient({
          region: env.AWS_REGION,
          endpoint: env.AWS_ENDPOINT_URL_SQS,
          queueName: env.SQS_QUEUE_PUSH,
        }),
        env.SQS_QUEUE_PUSH,
      ),
  },
  {
    provide: PushSender,
    inject: [WorkerConfig],
    useFactory: ({ env }: WorkerConfig): PushSender => createPushSender(env),
  },
  {
    provide: PushJobHandler,
    inject: [DATABASE, PushSender, Clock, Tracing],
    useFactory: (database: DbHandle, sender: PushSender, clock: Clock, tracing: Tracing) =>
      new PushJobHandler(database.db, sender, clock, tracing),
  },
  {
    provide: PushConsumer,
    inject: [PUSH_QUEUE, PushJobHandler, WorkerConfig],
    useFactory: (queue: MessageQueue, handler: PushJobHandler, { env }: WorkerConfig) =>
      new PushConsumer(queue, handler, {
        concurrency: env.PUSH_JOBS_CONCURRENCY,
        waitTimeSeconds: env.MEDIA_JOBS_WAIT_S,
        maxAttempts: env.PUSH_JOBS_MAX_ATTEMPTS,
      }),
  },
];
