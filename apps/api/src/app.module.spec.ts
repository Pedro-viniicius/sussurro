import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { DATABASE } from './infra/database/database.providers.js';
import { HealthController } from './infra/health/health.controller.js';
import { HealthService } from './infra/health/health.service.js';
import { REDIS } from './infra/redis/redis.providers.js';
import { fakeDependencies, testEnv } from './testing/test-env.js';

// Detector do risco F0-4 (fase-0-plano.md §3.1): o HealthController recebe o HealthService
// só pelo tipo do parâmetro do construtor, sem @Inject. Se o SWC não emitir a metadata dos
// decorators (decoratorMetadata no .swcrc), o Nest não sabe o que injetar e este teste falha.
describe('AppModule', () => {
  it('compila e resolve providers por tipo (metadata de decorators emitida)', async () => {
    const deps = fakeDependencies();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(testEnv())] })
      .overrideProvider(DATABASE)
      .useValue(deps.database)
      .overrideProvider(REDIS)
      .useValue(deps.redis)
      .compile();

    const controller = moduleRef.get(HealthController);
    const service = moduleRef.get(HealthService);
    expect(service).toBeInstanceOf(HealthService);

    const ready = await controller.ready({ status: () => undefined } as never);
    expect(ready.status).toBe('ok');
    expect(deps.redis.ping).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });

  it('o desligamento fecha o pool do Postgres e o Redis', async () => {
    const deps = fakeDependencies();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(testEnv())] })
      .overrideProvider(DATABASE)
      .useValue(deps.database)
      .overrideProvider(REDIS)
      .useValue(deps.redis)
      .compile();
    await moduleRef.init();
    await moduleRef.close();
    expect(deps.database.close).toHaveBeenCalledTimes(1);
    expect(deps.redis.quit).toHaveBeenCalledTimes(1);
  });

  it('sem dublês, cria os clientes reais sem abrir conexão (pool e Redis preguiçosos)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(testEnv())],
    }).compile();
    await moduleRef.init();
    const redis = moduleRef.get<{ status: string }>(REDIS);
    expect(redis.status).toBe('wait');
    await moduleRef.close();
  });
});
