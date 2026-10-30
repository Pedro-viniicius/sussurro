import { Module } from '@nestjs/common';

import { FollowsController, SearchController } from './follows.controller.js';
import { FollowsRepository } from './follows.repository.js';
import { FollowsService } from './follows.service.js';
import { MediaModule } from '../media/media.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { UsersModule } from '../users/users.module.js';

/**
 * Seguir e deixar de seguir (pessoal → criador) e a busca de criadores por prefixo (arquitetura.md
 * §5). A lista própria de seguidos fica no módulo `own-lists` (ADR 0004). Todas as rotas daqui são
 * só de conta pessoal (PERM-05 confere).
 */
@Module({
  imports: [PoliciesModule, UsersModule, MediaModule, NotificationsModule],
  controllers: [SearchController, FollowsController],
  providers: [FollowsRepository, FollowsService],
})
export class FollowsModule {}
