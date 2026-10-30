import { type DynamicModule, Module } from '@nestjs/common';

import type { ApiEnv } from './env.schema.js';

/** Configuração validada, injetável por tipo. */
export class AppConfig {
  constructor(readonly env: ApiEnv) {}
}

@Module({})
export class AppConfigModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AppConfigModule,
      global: true,
      providers: [{ provide: AppConfig, useValue: new AppConfig(env) }],
      exports: [AppConfig],
    };
  }
}
