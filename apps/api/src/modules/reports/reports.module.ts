import { Module } from '@nestjs/common';

import { ModerationSignalsService } from './moderation-signals.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';
import { CommentsModule } from '../comments/comments.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { PostsModule } from '../posts/posts.module.js';
import { ProximityModule } from '../proximity/proximity.module.js';
import { UsersModule } from '../users/users.module.js';

/**
 * Denúncias e a fila de moderação mínima por e-mail (X.1, D5). (ADR 0012, A2-3) Exporta os sinais
 * automáticos para a moderação (`ModerationSignalsService`), usados pelo bloqueio. (A2 rev. 1,
 * R1-5) Importa a política e a proximidade para a denúncia de conta pelo cartão do encosto (sem
 * ciclo: nenhum dos dois importa este módulo).
 */
@Module({
  imports: [PostsModule, CommentsModule, UsersModule, PoliciesModule, ProximityModule],
  controllers: [ReportsController],
  providers: [ReportsRepository, ReportsService, ModerationSignalsService],
  exports: [ModerationSignalsService],
})
export class ReportsModule {}
