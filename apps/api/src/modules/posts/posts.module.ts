import { Module } from '@nestjs/common';

import { PostViewService } from './post-view.service.js';
import { PostsController, UserPostsController } from './posts.controller.js';
import { PostsRepository } from './posts.repository.js';
import { PostsService } from './posts.service.js';
import { MediaModule } from '../media/media.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { UsersModule } from '../users/users.module.js';

/** Criação de texto, rascunhos de foto, publicação, exclusão e leitura por perfil (arquitetura §5). */
@Module({
  imports: [PoliciesModule, MediaModule, UsersModule],
  controllers: [PostsController, UserPostsController],
  providers: [PostsRepository, PostViewService, PostsService],
  exports: [PostsService, PostViewService],
})
export class PostsModule {}
