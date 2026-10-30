import { Global, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { CounterCache, RedisCounterCache } from './cache/counter-cache.js';
import { Clock, SystemClock } from './clock/clock.js';
import { CursorCodec, deriveCursorKey } from './http/cursor.js';
import { RateLimitStore, RedisRateLimitStore } from './rate-limit/rate-limit.store.js';
import { RateLimiterService } from './rate-limit/rate-limiter.service.js';
import { AppConfig } from '../config/config.module.js';
import { REDIS } from '../infra/redis/redis.providers.js';

/**
 * Providers técnicos usados por todos os módulos: relógio, rate limit, cache de contadores e
 * cursores assinados.
 */
@Global()
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    {
      provide: RateLimitStore,
      inject: [REDIS],
      useFactory: (redis: Redis) => new RedisRateLimitStore(redis),
    },
    RateLimiterService,
    {
      provide: CounterCache,
      inject: [REDIS],
      useFactory: (redis: Redis) => new RedisCounterCache(redis),
    },
    {
      provide: CursorCodec,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new CursorCodec(deriveCursorKey(config.env.JWT_ACCESS_SECRET)),
    },
  ],
  exports: [Clock, RateLimitStore, RateLimiterService, CounterCache, CursorCodec],
})
export class CommonModule {}
