import { Module } from '@nestjs/common';

import { BlocksController } from './blocks.controller.js';
import { BlocksRepository } from './blocks.repository.js';
import { BlocksService } from './blocks.service.js';
import { CommentsModule } from '../comments/comments.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { ProximityModule } from '../proximity/proximity.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { UsersModule } from '../users/users.module.js';

/**
 * Bloquear e desbloquear (X.2, D5). O efeito na visibilidade é do `AccessPolicyService`. (ADR 0012,
 * A2-3) Importa a proximidade e as denúncias para o sinal de bloqueio logo depois de um encosto
 * (sem ciclo: nenhum dos dois importa este módulo).
 */
@Module({
  imports: [
    PoliciesModule,
    UsersModule,
    CommentsModule,
    NotificationsModule,
    ProximityModule,
    ReportsModule,
  ],
  controllers: [BlocksController],
  providers: [BlocksRepository, BlocksService],
})
export class BlocksModule {}
