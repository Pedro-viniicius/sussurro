import { Module } from '@nestjs/common';

import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';
import { CommentsModule } from '../comments/comments.module.js';
import { PostsModule } from '../posts/posts.module.js';
import { UsersModule } from '../users/users.module.js';

/** Denúncias e a fila de moderação mínima por e-mail (X.1, D5). */
@Module({
  imports: [PostsModule, CommentsModule, UsersModule],
  controllers: [ReportsController],
  providers: [ReportsRepository, ReportsService],
})
export class ReportsModule {}
