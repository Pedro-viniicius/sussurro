import { Logger, type Provider } from '@nestjs/common';
import { Redis } from 'ioredis';

import { describeError } from '../../common/errors/describe-error.js';
import { AppConfig } from '../../config/config.module.js';

/** Token do cliente `ioredis` (Valkey em dev e na AWS; o protocolo é o do Redis). */
export const REDIS = Symbol('REDIS');

/**
 * Cliente preguiçoso: só conecta no primeiro comando. Se o Redis cair, o cliente tenta
 * reconectar sozinho (até 2 s entre tentativas) e o `/health/ready` volta a 200 sem
 * reiniciar a API (F0-API-03).
 */
export function createRedisClient(url: string, logger: Pick<Logger, 'warn' | 'log'>): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });

  // Sem ouvinte de "error" o ioredis imprime cada falha de reconexão. Registramos só a
  // transição (caiu / voltou) para não inundar o log.
  let down = false;
  client.on('error', (error: Error) => {
    if (!down) {
      down = true;
      logger.warn(`Redis indisponível: ${describeError(error)}`);
    }
  });
  client.on('ready', () => {
    if (down) {
      down = false;
      logger.log('Redis disponível de novo');
    }
  });
  return client;
}

/** Fecha o cliente sem travar se ele nunca conectou ou está reconectando. */
export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    await client.quit();
    return;
  }
  client.disconnect();
}

export const redisProvider: Provider<Redis> = {
  provide: REDIS,
  inject: [AppConfig],
  useFactory: (config: AppConfig): Redis =>
    createRedisClient(config.env.REDIS_URL, new Logger('Redis')),
};
