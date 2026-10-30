import { Module } from '@nestjs/common';

import { FeedController } from './feed.controller.js';
import { FeedRepository } from './feed.repository.js';
import { FeedService } from './feed.service.js';
import { PostsModule } from '../posts/posts.module.js';

/** Query cronológica por janela e aba, cursor e `caughtUp` (ADR 0005). */
@Module({
  imports: [PostsModule],
  controllers: [FeedController],
  providers: [FeedRepository, FeedService],
})
export class FeedModule {}
