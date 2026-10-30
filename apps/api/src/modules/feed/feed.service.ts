import { Injectable } from '@nestjs/common';
import type { FeedPage, FeedQuery } from '@sussurro/shared';
import { z } from 'zod';

import { FeedRepository } from './feed.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { CursorCodec, invalidCursor } from '../../common/http/cursor.js';
import { AppConfig } from '../../config/config.module.js';
import { PostViewService } from '../posts/post-view.service.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Cursor do feed (ADR 0005): aba (`t`), início da janela (`s`), `published_at` (`a`, ms) e id
 * (`i`) do último item. Assinado: adulterado ou de outra lista → 400 (FEED-08).
 */
const FeedCursorSchema = z.object({
  t: z.enum(['photo', 'text', 'reel']),
  s: z.int().nonnegative(),
  a: z.int().nonnegative(),
  i: z.uuid(),
});
const FEED_CURSOR = 'feed';

@Injectable()
export class FeedService {
  constructor(
    private readonly feed: FeedRepository,
    private readonly views: PostViewService,
    private readonly cursors: CursorCodec,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * Página do feed (história 2.5). A janela (`FEED_WINDOW_HOURS`) é fixada na primeira página: o
   * post que "envelhece" durante a rolagem continua aparecendo (FEED-07c). Um cursor nunca estende
   * a janela além de `janela + 1 h` (FEED-08). Cursor de outra aba → 400.
   */
  async getFeed(viewer: AuthContext, query: FeedQuery): Promise<FeedPage> {
    const windowHours = this.config.env.FEED_WINDOW_HOURS;
    const now = this.clock.now().getTime();
    const windowStart = now - windowHours * HOUR_MS;
    let since = windowStart;
    let after: { at: Date; id: string } | undefined;
    if (query.cursor !== undefined) {
      const cursor = this.cursors.decode(FEED_CURSOR, query.cursor, FeedCursorSchema);
      if (cursor.t !== query.type) {
        throw invalidCursor();
      }
      since = Math.min(Math.max(cursor.s, windowStart - HOUR_MS), now);
      after = { at: new Date(cursor.a), id: cursor.i };
    }

    const rows = await this.feed.page({
      viewerId: viewer.userId,
      type: query.type,
      since: new Date(since),
      after,
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last?.publishedAt != null
        ? this.cursors.encode(FEED_CURSOR, {
            t: query.type,
            s: since,
            a: last.publishedAt.getTime(),
            i: last.id,
          })
        : null;
    return {
      items: await this.views.toPosts(viewer, page),
      nextCursor,
      caughtUp: nextCursor === null,
      windowHours,
    };
  }
}
