import { type DynamicModule, Module } from '@nestjs/common';

import type { WorkerEnv } from './env.schema.js';

/** Configuração validada, injetável por tipo. */
export class WorkerConfig {
  constructor(readonly env: WorkerEnv) {}
}

@Module({})
export class WorkerConfigModule {
  static forRoot(env: WorkerEnv): DynamicModule {
    return {
      module: WorkerConfigModule,
      global: true,
      providers: [{ provide: WorkerConfig, useValue: new WorkerConfig(env) }],
      exports: [WorkerConfig],
    };
  }
}
