import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { loadWorkerEnv } from './config/env.schema.js';
import { DATABASE, REDIS } from './infra/connections.js';
import { VIDEO_EVENTS_QUEUE } from './infra/media.providers.js';
import { PUSH_QUEUE } from './infra/push.providers.js';
import { MessageQueue } from './infra/queue.js';
import { ObjectStorage } from './infra/storage.js';
import { MediaConvertVideoProcessor } from './media/mediaconvert-video-processor.js';
import { PassthroughVideoProcessor } from './media/passthrough-video-processor.js';
import { VideoProcessor } from './media/video-processor.js';
import { ExpoPushSender, LogPushSender, PushSender } from './push/push-sender.js';
import { InMemoryQueue } from './testing/in-memory-queue.js';
import { InMemoryObjectStorage } from './testing/in-memory-storage.js';
import { WorkerLifecycle } from './worker.lifecycle.js';
import { WorkerModule } from './worker.module.js';

const env = loadWorkerEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://sussurro:sussurro@localhost:5432/sussurro_unit',
  REDIS_URL: 'redis://localhost:6379/15',
});

function fakes() {
  return {
    database: { db: {}, close: vi.fn().mockResolvedValue(undefined) },
    redis: { status: 'ready', quit: vi.fn().mockResolvedValue('OK'), disconnect: vi.fn() },
  };
}

async function compile(deps = fakes()): Promise<TestingModule> {
  // S3 e SQS em memória: o consumidor da fila sobe junto, sem rede.
  return (
    Test.createTestingModule({ imports: [WorkerModule.register(env)] })
      .overrideProvider(DATABASE)
      .useValue(deps.database)
      .overrideProvider(REDIS)
      .useValue(deps.redis)
      .overrideProvider(ObjectStorage)
      .useValue(new InMemoryObjectStorage())
      .overrideProvider(MessageQueue)
      .useValue(new InMemoryQueue())
      // Fase 6: a fila push também em memória (nenhuma chamada ao SQS).
      .overrideProvider(PUSH_QUEUE)
      .useValue(new InMemoryQueue())
      .compile()
  );
}

describe('WorkerModule', () => {
  it('CA3 (0.5): compila e resolve o WorkerConfig por tipo (metadata de decorators)', async () => {
    const moduleRef = await compile();
    const lifecycle = moduleRef.get(WorkerLifecycle);
    expect(lifecycle).toBeInstanceOf(WorkerLifecycle);
    // WorkerConfig é injetado só pelo tipo: sem a metadata, o bootstrap quebraria aqui.
    await moduleRef.init();
    expect(lifecycle.running).toBe(true);
    await moduleRef.close();
  });

  it('F0-API-07: o desligamento para o worker e fecha Postgres e Redis', async () => {
    const deps = fakes();
    const moduleRef = await compile(deps);
    await moduleRef.init();
    const lifecycle = moduleRef.get(WorkerLifecycle);

    await moduleRef.close();
    expect(lifecycle.running).toBe(false);
    expect(deps.database.close).toHaveBeenCalledTimes(1);
    expect(deps.redis.quit).toHaveBeenCalledTimes(1);
  });

  it('Redis que nunca conectou é desconectado sem QUIT (não trava o desligamento)', async () => {
    const deps = fakes();
    deps.redis.status = 'wait';
    const moduleRef = await compile(deps);
    await moduleRef.init();
    await moduleRef.close();
    expect(deps.redis.quit).not.toHaveBeenCalled();
    expect(deps.redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('CONTA-05: o job de manutenção falha sem derrubar o worker (o erro vai para o log)', async () => {
    const moduleRef = await compile();
    await moduleRef.init();
    const lifecycle = moduleRef.get(WorkerLifecycle);
    // O dublê do banco não tem query builder: a execução falha e é absorvida.
    await expect(lifecycle.runMaintenanceNow(new Date())).resolves.toBeUndefined();
    expect(lifecycle.running).toBe(true);
    await moduleRef.close();
  });
});

describe('WorkerModule: VideoProcessor pelo VIDEO_PROCESSOR (5.1 CA1)', () => {
  async function compileWith(extra: Record<string, string>) {
    const videoEnv = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://sussurro:sussurro@localhost:5432/sussurro_unit',
      REDIS_URL: 'redis://localhost:6379/15',
      ...extra,
    });
    const deps = fakes();
    return Test.createTestingModule({ imports: [WorkerModule.register(videoEnv)] })
      .overrideProvider(DATABASE)
      .useValue(deps.database)
      .overrideProvider(REDIS)
      .useValue(deps.redis)
      .overrideProvider(ObjectStorage)
      .useValue(new InMemoryObjectStorage())
      .overrideProvider(MessageQueue)
      .useValue(new InMemoryQueue())
      .overrideProvider(VIDEO_EVENTS_QUEUE)
      .useValue(new InMemoryQueue())
      .overrideProvider(PUSH_QUEUE)
      .useValue(new InMemoryQueue())
      .compile();
  }

  it('passthrough: copia em dev e não consome a video-events', async () => {
    const moduleRef = await compileWith({ VIDEO_PROCESSOR: 'passthrough' });
    expect(moduleRef.get(VideoProcessor)).toBeInstanceOf(PassthroughVideoProcessor);
    await moduleRef.init();
    expect(moduleRef.get(WorkerLifecycle).consumingVideoEvents).toBe(false);
    await moduleRef.close();
  });

  it('mediaconvert: troca só pelo env, e o consumidor da video-events sobe junto', async () => {
    const moduleRef = await compileWith({
      VIDEO_PROCESSOR: 'mediaconvert',
      MEDIACONVERT_ROLE_ARN: 'arn:aws:iam::123456789012:role/sussurro-mediaconvert',
    });
    expect(moduleRef.get(VideoProcessor)).toBeInstanceOf(MediaConvertVideoProcessor);
    await moduleRef.init();
    const lifecycle = moduleRef.get(WorkerLifecycle);
    expect(lifecycle.consumingVideoEvents).toBe(true);
    await moduleRef.close();
    expect(lifecycle.consumingVideoEvents).toBe(false);
  });

  it('Fase 6: o consumidor da push sobe e para com o worker; o sender troca só pelo env (log em dev, Expo em produção)', async () => {
    const dev = await compileWith({});
    expect(dev.get(PushSender)).toBeInstanceOf(LogPushSender);
    await dev.init();
    const lifecycle = dev.get(WorkerLifecycle);
    expect(lifecycle.consumingPush).toBe(true);
    await dev.close();
    expect(lifecycle.consumingPush).toBe(false);

    // O cliente do Expo só é criado (nada é enviado sem mensagem na fila).
    const expo = await compileWith({ PUSH_SENDER: 'expo' });
    expect(expo.get(PushSender)).toBeInstanceOf(ExpoPushSender);
  });
});
