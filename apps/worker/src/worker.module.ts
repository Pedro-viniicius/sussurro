import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { WorkerConfig, WorkerConfigModule } from './config/config.module.js';
import type { WorkerEnv } from './config/env.schema.js';
import { DATABASE, databaseProvider, REDIS, redisProvider } from './infra/connections.js';
import { mediaProviders } from './infra/media.providers.js';
import { pushProviders } from './infra/push.providers.js';
import { WorkerLifecycle } from './worker.lifecycle.js';

@Module({})
export class WorkerModule {
  /** Recebe o ambiente já validado (main.ts ou testes). */
  static register(env: WorkerEnv): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        WorkerConfigModule.forRoot(env),
        LoggerModule.forRootAsync({
          inject: [WorkerConfig],
          useFactory: (config: WorkerConfig) => ({ pinoHttp: { level: config.env.LOG_LEVEL } }),
        }),
      ],
      providers: [
        databaseProvider,
        redisProvider,
        ...mediaProviders,
        // Fase 6: fila push, envio ao Expo (ou log em dev), recibos e tracing.
        ...pushProviders,
        WorkerLifecycle,
      ],
      exports: [DATABASE, REDIS],
    };
  }
}
