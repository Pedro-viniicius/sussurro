// App Nest de teste para os e2e (testes.md §2.1): o mesmo AppModule de produção, trocando só o
// banco (Postgres do compose ou PGlite, ver TEST_DB), o relógio, o envio de e-mail e, por padrão,
// o S3 e a fila (fakes em memória; os testes com SeaweedFS/ElasticMQ pedem `realStorage`).
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createTestDatabase, type TestDatabase } from '@sussurro/db/testing';
import type { Redis } from 'ioredis';
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import request from 'supertest';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { CounterCache } from '../../src/common/cache/counter-cache.js';
import { Clock } from '../../src/common/clock/clock.js';
import {
  RateLimitStore,
  RedisRateLimitStore,
} from '../../src/common/rate-limit/rate-limit.store.js';
import { DATABASE } from '../../src/infra/database/database.providers.js';
import { EmailSender } from '../../src/infra/email/email-sender.js';
import { buildLoggerParams } from '../../src/infra/observability/logger.options.js';
import { REDIS } from '../../src/infra/redis/redis.providers.js';
import { MediaJobsQueue } from '../../src/infra/storage/media-jobs-queue.js';
import { ObjectStorage } from '../../src/infra/storage/object-storage.js';
import { PushQueue } from '../../src/infra/storage/push-queue.js';
import { ProximityRepository } from '../../src/modules/proximity/proximity.repository.js';
import { ProximityStore } from '../../src/modules/proximity/proximity.store.js';
import { CapturingEmailSender } from '../../src/testing/capturing-email-sender.js';
import { ClockSyncedRateLimitStore } from '../../src/testing/clock-synced-rate-limit.store.js';
import { FakeClock } from '../../src/testing/fake-clock.js';
import { InMemoryCounterCache } from '../../src/testing/in-memory-counter-cache.js';
import { InMemoryMediaJobsQueue } from '../../src/testing/in-memory-media-jobs-queue.js';
import { InMemoryObjectStorage } from '../../src/testing/in-memory-object-storage.js';
import { InMemoryPushQueue } from '../../src/testing/in-memory-push-queue.js';
import { InMemoryRateLimitStore } from '../../src/testing/in-memory-rate-limit.store.js';
import { cloudFrontTestEnv, testEnv } from '../../src/testing/test-env.js';
import { TestProximityStore } from '../../src/testing/test-proximity.store.js';
import { WallClockRedis } from '../../src/testing/wall-clock-redis.js';

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  clock: FakeClock;
  outbox: CapturingEmailSender;
  database: TestDatabase;
  /** S3 em memória (fora de uso com `realStorage`). */
  storage: InMemoryObjectStorage;
  /** Fila `media-jobs` em memória: mensagens enviadas pela API. */
  queue: InMemoryMediaJobsQueue;
  /** Fila `push` em memória (Fase 6): mensagens enviadas pela API, nos dois modos. */
  push: InMemoryPushQueue;
  /** Cache de contadores em memória (seguidores, 60 s pelo relógio de teste, CNT-02). */
  counters: InMemoryCounterCache;
  /**
   * Tokens de proximidade em memória (Fase 4): validades de 30 e 120 s pelo relógio de teste, sem
   * `sleep`, e `down = true` simula o Redis fora (PROX-21).
   */
  proximity: TestProximityStore;
  /** Estado limpo entre testes: tabelas, contadores de rate limit, e-mails, S3, fila e relógio. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /** Controllers só de teste (ex.: rota sem schema para o PERM-12). */
  controllers?: Type[];
  /** Variáveis de ambiente a mais (ex.: `FEED_WINDOW_HOURS=1`). */
  env?: Record<string, string>;
  /**
   * Usa o S3 e a fila do `.env` (SeaweedFS e ElasticMQ do compose) em vez dos fakes. Só nos
   * testes que precisam do comportamento real (pulados no modo PGlite).
   */
  realStorage?: boolean;
  /**
   * PERM-17: o pino de produção (`buildLoggerParams`, com o `redact` e os serializers) escreve
   * neste stream em vez do stdout, para o teste ler cada linha do log. O nível vem de `LOG_LEVEL`
   * em `env` (o padrão dos testes é `silent`).
   */
  logStream?: DestinationStream;
}

/** Um índice do Redis por worker do Vitest (testes.md §3.1). */
function redisUrlForWorker(): string {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const worker = Number(process.env.VITEST_POOL_ID ?? '0');
  url.pathname = `/${String(1 + (worker % 15))}`;
  return url.toString();
}

/** Dublê do cliente Redis no modo PGlite: só o que o health e o desligamento usam. */
function fakeRedis() {
  return {
    ping: () => Promise.resolve('PONG' as const),
    status: 'ready',
    quit: () => Promise.resolve('OK'),
    disconnect: () => undefined,
  };
}

/**
 * O repositório de produção (as mesmas consultas) que anota cada `findNearby` (o `resolve`) no
 * `calls` do fake da proximidade, na mesma lista das idas ao Valkey.
 */
function recordingProximityRepository(
  handle: TestDatabase['handle'],
  proximity: TestProximityStore,
): ProximityRepository {
  class RecordingProximityRepository extends ProximityRepository {
    override findNearby(...args: Parameters<ProximityRepository['findNearby']>) {
      proximity.noteCall('findNearby');
      return super.findNearby(...args);
    }
  }
  return new RecordingProximityRepository(handle);
}

/** Valor da variável; vazia conta como ausente. */
function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

/**
 * S3/SQS reais: os emuladores do compose (`.env` da raiz ou as variáveis do CI). Sem variável, vale
 * o endereço local do compose, nunca a AWS real.
 */
function realStorageEnv(): Record<string, string> {
  process.env.AWS_ACCESS_KEY_ID = envOr('AWS_ACCESS_KEY_ID', 'local');
  process.env.AWS_SECRET_ACCESS_KEY = envOr('AWS_SECRET_ACCESS_KEY', 'local');
  const s3 = envOr('AWS_ENDPOINT_URL_S3', 'http://localhost:8333');
  return {
    AWS_REGION: envOr('AWS_REGION', 'sa-east-1'),
    AWS_ENDPOINT_URL_S3: s3,
    // O PUT pré-assinado deste teste sai do próprio PC: o endpoint público é o interno.
    S3_PUBLIC_ENDPOINT_URL: s3,
    S3_FORCE_PATH_STYLE: envOr('S3_FORCE_PATH_STYLE', 'true'),
    S3_BUCKET_MEDIA: envOr('S3_BUCKET_MEDIA', 'sussurro-media'),
    AWS_ENDPOINT_URL_SQS: envOr('AWS_ENDPOINT_URL_SQS', 'http://localhost:9324'),
    SQS_QUEUE_MEDIA_JOBS: envOr('SQS_QUEUE_MEDIA_JOBS', 'media-jobs'),
  };
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = await createTestDatabase();
  const clock = new FakeClock();
  const outbox = new CapturingEmailSender();
  const storage = new InMemoryObjectStorage(clock);
  const queue = new InMemoryMediaJobsQueue();
  const push = new InMemoryPushQueue();
  const counters = new InMemoryCounterCache(clock);
  const proximity = new TestProximityStore(clock);
  // Mídia assinada no formato do CloudFront com uma chave RSA gerada no teste (PERM-16).
  const env = testEnv({
    REDIS_URL: redisUrlForWorker(),
    ...cloudFrontTestEnv(),
    ...(options.realStorage === true ? realStorageEnv() : {}),
    ...options.env,
  });

  let builder = Test.createTestingModule({
    imports: [AppModule.register(env)],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(DATABASE)
    .useValue(database.handle)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(EmailSender)
    .useValue(outbox)
    // Nos dois modos (como o S3 e a fila): o teste avança o relógio em vez de esperar o TTL.
    .overrideProvider(CounterCache)
    .useValue(counters)
    .overrideProvider(ProximityStore)
    .useValue(proximity)
    .overrideProvider(ProximityRepository)
    .useValue(recordingProximityRepository(database.handle, proximity))
    // Fase 6: a fila push é sempre o fake (o consumo e o Expo ficam no worker, também com fakes).
    .overrideProvider(PushQueue)
    .useValue(push);

  if (options.logStream !== undefined) {
    const { pinoHttp } = buildLoggerParams(env);
    builder = builder
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useValue({ pinoHttp: [pinoHttp as PinoHttpOptions, options.logStream] });
  }

  if (options.realStorage !== true) {
    builder = builder
      .overrideProvider(ObjectStorage)
      .useValue(storage)
      .overrideProvider(MediaJobsQueue)
      .useValue(queue);
  }

  // Rate limit: o teste avança o relógio e espera a janela reiniciar (A-27), nos dois modos.
  // - Modo real: o store de produção (script Lua no Valkey do compose/CI), com o TTL das chaves
  //   `rl:*` descontado do tempo que o FakeClock andou (`ClockSyncedRateLimitStore`). Sem isso a
  //   janela só vence pelo relógio do Valkey e todo teste "429 → avança → passa" falha no CI.
  // - PGlite (sem Docker não há Valkey): o fake em memória sobre o relógio, e o health com um
  //   dublê do Redis. Com `TEST_RATE_LIMIT_STORE=valkey-sim`, o mesmo caminho do modo real sobre um
  //   dublê do Valkey com TTL pelo relógio de verdade (`WallClockRedis`), para reproduzi-lo aqui.
  let memoryRateLimits: InMemoryRateLimitStore | null = null;
  let simulatedValkey: WallClockRedis | null = null;
  let syncedRateLimits: ClockSyncedRateLimitStore | null = null;
  if (database.mode === 'pglite') {
    builder = builder.overrideProvider(REDIS).useValue(fakeRedis());
    if (process.env.TEST_RATE_LIMIT_STORE?.trim() === 'valkey-sim') {
      simulatedValkey = new WallClockRedis();
      syncedRateLimits = new ClockSyncedRateLimitStore(
        new RedisRateLimitStore(simulatedValkey),
        simulatedValkey,
        clock,
      );
      builder = builder.overrideProvider(RateLimitStore).useValue(syncedRateLimits);
    } else {
      memoryRateLimits = new InMemoryRateLimitStore(clock);
      builder = builder.overrideProvider(RateLimitStore).useValue(memoryRateLimits);
    }
  } else {
    builder = builder.overrideProvider(RateLimitStore).useFactory({
      inject: [REDIS],
      factory: (redis: Redis) => {
        syncedRateLimits = new ClockSyncedRateLimitStore(
          new RedisRateLimitStore(redis),
          redis,
          clock,
        );
        return syncedRateLimits;
      },
    });
  }

  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(), env);
  await app.init();
  const http = request(app.getHttpServer());

  return {
    app,
    http,
    clock,
    outbox,
    database,
    storage,
    queue,
    push,
    counters,
    proximity,
    reset: async () => {
      await database.truncate();
      if (memoryRateLimits !== null) {
        memoryRateLimits.clear();
      } else if (simulatedValkey !== null) {
        await simulatedValkey.flushdb();
      } else {
        await app.get<Redis>(REDIS).flushdb();
      }
      outbox.clear();
      storage.clear();
      queue.clear();
      push.clear();
      counters.clear();
      proximity.clear();
      clock.reset();
      // O relógio voltou ao início: o próximo avanço conta a partir daqui.
      syncedRateLimits?.resync();
    },
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}
