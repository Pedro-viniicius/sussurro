import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { CommonModule } from './common/common.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ResponseSchemaInterceptor } from './common/http/response-schema.js';
import { AppConfigModule } from './config/config.module.js';
import type { ApiEnv } from './config/env.schema.js';
import { DatabaseModule } from './infra/database/database.module.js';
import { EmailModule } from './infra/email/email.module.js';
import { HealthModule } from './infra/health/health.module.js';
import { LoggerModule } from './infra/observability/logger.module.js';
import { HttpTracingInterceptor, TracingModule } from './infra/observability/tracing.module.js';
import { RedisModule } from './infra/redis/redis.module.js';
import { StorageModule } from './infra/storage/storage.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BlocksModule } from './modules/blocks/blocks.module.js';
import { CommentsModule } from './modules/comments/comments.module.js';
import { ConnectionsModule } from './modules/connections/connections.module.js';
import { DevModule } from './modules/dev/dev.module.js';
import { FeedModule } from './modules/feed/feed.module.js';
import { FollowsModule } from './modules/follows/follows.module.js';
import { LikesModule } from './modules/likes/likes.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OwnListsModule } from './modules/own-lists/own-lists.module.js';
import { PostsModule } from './modules/posts/posts.module.js';
import { ProximityModule } from './modules/proximity/proximity.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { UsersModule } from './modules/users/users.module.js';

/**
 * Módulos só de desenvolvimento (D15): as rotas `/dev/*` existem só com `NODE_ENV=development`.
 * Em `test` e `production` nem são registradas (PROX-30).
 */
export function devModules(env: Pick<ApiEnv, 'NODE_ENV'>): (typeof DevModule)[] {
  return env.NODE_ENV === 'development' ? [DevModule] : [];
}

@Module({})
export class AppModule {
  /** Recebe o ambiente já validado (main.ts ou testes). */
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(env),
        LoggerModule,
        TracingModule,
        DatabaseModule,
        RedisModule,
        StorageModule,
        CommonModule,
        EmailModule,
        HealthModule,
        UsersModule,
        AuthModule,
        PostsModule,
        FeedModule,
        LikesModule,
        CommentsModule,
        // Fase 3: busca, seguir, listas próprias, bloquear e denunciar.
        FollowsModule,
        OwnListsModule,
        BlocksModule,
        ReportsModule,
        // Fase 4: conexão presencial (tokens de proximidade, pedidos, desfazer conexão).
        ProximityModule,
        ConnectionsModule,
        // Fase 6: notificações, push tokens e o enfileiramento do push.
        NotificationsModule,
        ...devModules(env),
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        // Fase 6 (6.8): span por requisição, só com OTEL_ENABLED=true.
        { provide: APP_INTERCEPTOR, useClass: HttpTracingInterceptor },
        // Toda resposta passa pelo schema Zod declarado na rota (ADR 0004).
        { provide: APP_INTERCEPTOR, useClass: ResponseSchemaInterceptor },
      ],
    };
  }
}
