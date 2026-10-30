import { Logger, type Provider } from '@nestjs/common';
import { createDb, type DbHandle } from '@sussurro/db';
import { Redis } from 'ioredis';

import { describeError } from './describe-error.js';
import { WorkerConfig } from '../config/config.module.js';

/** Token do `DbHandle` ({ db, pool, close }). Usado pelos consumidores a partir da Fase 2. */
export const DATABASE = Symbol('DATABASE');
/** Token do cliente `ioredis`. */
export const REDIS = Symbol('REDIS');

export const databaseProvider: Provider<DbHandle> = {
  provide: DATABASE,
  inject: [WorkerConfig],
  useFactory: (config: WorkerConfig): DbHandle => {
    const logger = new Logger('Database');
    return createDb(config.env.DATABASE_URL, {
      max: 5,
      applicationName: 'sussurro-worker',
      onIdleError: (error) => {
        logger.warn(`Conexão ociosa do Postgres caiu: ${describeError(error)}`);
      },
    });
  },
};

export const redisProvider: Provider<Redis> = {
  provide: REDIS,
  inject: [WorkerConfig],
  useFactory: (config: WorkerConfig): Redis => {
    const logger = new Logger('Redis');
    const client = new Redis(config.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    client.on('error', (error: Error) => {
      logger.warn(`Redis: ${describeError(error)}`);
    });
    return client;
  },
};

/** Fecha o cliente sem travar se ele nunca conectou ou está reconectando. */
export async function closeRedisClient(client: Pick<Redis, 'status' | 'quit' | 'disconnect'>) {
  if (client.status === 'ready') {
    await client.quit();
    return;
  }
  client.disconnect();
}
