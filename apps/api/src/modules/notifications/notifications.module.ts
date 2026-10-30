import { Module } from '@nestjs/common';

import { NotificationsController, PushTokensController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';
import { PushTokensRepository } from './push-tokens.repository.js';
import { PushTokensService } from './push-tokens.service.js';
import { MediaModule } from '../media/media.module.js';
import { PoliciesModule } from '../policies/policies.module.js';

/**
 * Notificações e push tokens (arquitetura.md §5 e §12, ADR 0011; Fase 6). Os services são
 * exportados para quem grava os eventos na mesma transação (curtidas, comentários, seguir,
 * conexões, bloqueio) e para o `auth` (logout e exclusão de conta). Este módulo não importa
 * nenhum deles.
 */
@Module({
  imports: [PoliciesModule, MediaModule],
  controllers: [NotificationsController, PushTokensController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    PushTokensRepository,
    PushTokensService,
  ],
  exports: [NotificationsService, PushTokensService],
})
export class NotificationsModule {}
