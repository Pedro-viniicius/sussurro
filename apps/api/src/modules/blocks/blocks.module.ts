import { Module } from '@nestjs/common';

import { BlocksController } from './blocks.controller.js';
import { BlocksRepository } from './blocks.repository.js';
import { BlocksService } from './blocks.service.js';
import { CommentsModule } from '../comments/comments.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { UsersModule } from '../users/users.module.js';

/** Bloquear e desbloquear (X.2, D5). O efeito na visibilidade é do `AccessPolicyService`. */
@Module({
  imports: [PoliciesModule, UsersModule, CommentsModule, NotificationsModule],
  controllers: [BlocksController],
  providers: [BlocksRepository, BlocksService],
})
export class BlocksModule {}
