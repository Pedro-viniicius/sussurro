import { Controller, Get, Header, Query } from '@nestjs/common';
import { type FeedPage, FeedPageSchema, type FeedQuery, FeedQuerySchema } from '@sussurro/shared';

import { FeedService } from './feed.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth, RequireAccountType } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/** Feed cronológico (história 2.5). Criador não tem feed: 403 (FEED-13). */
@Controller('feed')
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(FeedPageSchema)
  getFeed(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(FeedQuerySchema)) query: FeedQuery,
  ): Promise<FeedPage> {
    return this.feed.getFeed(auth, query);
  }
}
