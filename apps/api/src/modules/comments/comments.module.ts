import { Module } from '@nestjs/common';

import { CommentsController, PostCommentsController } from './comments.controller.js';
import { CommentsRepository } from './comments.repository.js';
import { CommentsService } from './comments.service.js';
import { MediaModule } from '../media/media.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { PostsModule } from '../posts/posts.module.js';

/** Comentários e respostas (1 nível) e exclusão pelo autor do comentário ou do post. */
@Module({
  imports: [PostsModule, PoliciesModule, MediaModule, NotificationsModule],
  controllers: [PostCommentsController, CommentsController],
  providers: [CommentsRepository, CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
