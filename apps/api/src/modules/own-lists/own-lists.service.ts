import { Injectable } from '@nestjs/common';
import type { BlocksPage, ConnectionsPage, FollowingPage, OwnListQuery } from '@sussurro/shared';
import { z } from 'zod';

import {
  type OwnListAnchor,
  type OwnListPageQuery,
  type OwnListRow,
  OwnListsRepository,
} from './own-lists.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CursorCodec, invalidCursor } from '../../common/http/cursor.js';
import { MediaService } from '../media/media.service.js';

/**
 * Cursor das listas próprias: dono (`u`), `created_at` exato (`a`) e id da conta (`i`). O cursor
 * de uma lista não vale em outra nem para outra conta (400).
 */
const OwnListCursorSchema = z.object({
  u: z.uuid(),
  a: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.uuid(),
});

type ListKind = 'me-connections' | 'me-following' | 'me-blocks';

interface ListPage {
  rows: OwnListRow[];
  nextCursor: string | null;
}

/** Listas que só o dono vê (ADR 0004, história 3.6 e X.2 CA4). */
@Injectable()
export class OwnListsService {
  constructor(
    private readonly lists: OwnListsRepository,
    private readonly media: MediaService,
    private readonly cursors: CursorCodec,
  ) {}

  async connections(auth: AuthContext, query: OwnListQuery): Promise<ConnectionsPage> {
    const page = await this.load(auth, query, 'me-connections', (input) =>
      this.lists.listMyConnections(auth, input),
    );
    return { items: await this.withProfile(page.rows), nextCursor: page.nextCursor };
  }

  async following(auth: AuthContext, query: OwnListQuery): Promise<FollowingPage> {
    const page = await this.load(auth, query, 'me-following', (input) =>
      this.lists.listMyFollowing(auth, input),
    );
    return { items: await this.withProfile(page.rows), nextCursor: page.nextCursor };
  }

  /** Bloqueados: só o @ e a data (quem bloqueia não volta a ver nome nem foto, X.2). */
  async blocks(auth: AuthContext, query: OwnListQuery): Promise<BlocksPage> {
    const page = await this.load(auth, query, 'me-blocks', (input) =>
      this.lists.listMyBlocks(auth, input),
    );
    return {
      items: page.rows.map((row) => ({ handle: row.handle, blockedAt: row.since.toISOString() })),
      nextCursor: page.nextCursor,
    };
  }

  private async load(
    auth: AuthContext,
    query: OwnListQuery,
    kind: ListKind,
    fetch: (input: OwnListPageQuery) => Promise<OwnListRow[]>,
  ): Promise<ListPage> {
    let after: OwnListAnchor | undefined;
    if (query.cursor !== undefined) {
      const cursor = this.cursors.decode(kind, query.cursor, OwnListCursorSchema);
      if (cursor.u !== auth.userId) {
        throw invalidCursor();
      }
      after = { at: cursor.a, id: cursor.i };
    }
    const rows = await fetch({ after, limit: query.limit + 1 });
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? this.cursors.encode(kind, { u: auth.userId, a: last.sinceKey, i: last.id })
        : null;
    return { rows: pageRows, nextCursor };
  }

  private withProfile(rows: readonly OwnListRow[]) {
    return Promise.all(
      rows.map(async (row) => ({
        handle: row.handle,
        name: row.name,
        avatarUrl: await this.media.signUrl(row.avatarKey),
        since: row.since.toISOString(),
      })),
    );
  }
}
