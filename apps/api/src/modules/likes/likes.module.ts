import { Module } from '@nestjs/common';

import { LikesController } from './likes.controller.js';
import { LikesRepository } from './likes.repository.js';
import { LikesService } from './likes.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PostsModule } from '../posts/posts.module.js';

/** Curtir/descurtir idempotente e contador desnormalizado (arquitetura.md §5). */
@Module({
  imports: [PostsModule, NotificationsModule],
  controllers: [LikesController],
  providers: [LikesRepository, LikesService],
  exports: [LikesService],
})
export class LikesModule {}
