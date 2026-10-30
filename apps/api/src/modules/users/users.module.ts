import { Module } from '@nestjs/common';

import { AvatarController } from './avatar.controller.js';
import { AvatarRepository } from './avatar.repository.js';
import { AvatarService } from './avatar.service.js';
import { FollowerCountsService } from './follower-counts.service.js';
import { MeController } from './me.controller.js';
import { UsersController } from './users.controller.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';
import { MediaModule } from '../media/media.module.js';
import { PoliciesModule } from '../policies/policies.module.js';

@Module({
  imports: [PoliciesModule, MediaModule],
  controllers: [MeController, UsersController, AvatarController],
  providers: [
    UsersRepository,
    UsersService,
    FollowerCountsService,
    AvatarRepository,
    AvatarService,
  ],
  exports: [UsersService, FollowerCountsService],
})
export class UsersModule {}
