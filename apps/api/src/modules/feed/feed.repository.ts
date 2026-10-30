import { Inject, Injectable } from '@nestjs/common';
import { type DbHandle, sql } from '@sussurro/db';
import type { AccountType, PostStatus, PostType } from '@sussurro/shared';

import { rowsOf } from '../../common/db/rows.js';
import { DATABASE } from '../../infra/database/database.providers.js';
import type { PageAnchor, PostRecord } from '../posts/posts.repository.js';

export interface FeedPageQuery {
  viewerId: string;
  type: PostType;
  /** Início da janela, fixado na primeira página e carregado no cursor (ADR 0005). */
  since: Date;
  after: PageAnchor | undefined;
  limit: number;
}

interface FeedRow {
  id: string;
  author_id: string;
  author_handle: string;
  author_name: string;
  author_avatar_key: string | null;
  author_type: AccountType;
  type: PostType;
  status: PostStatus;
  text: string | null;
  caption: string | null;
  like_count: number | string;
  comment_count: number | string;
  created_ms: number | string;
  published_ms: number | string;
}

/**
 * Feed por janela com fan-out na leitura (ADR 0005, arquitetura.md §8): CTE com os autores
 * (conexões dos dois lados do par, criadores seguidos e o próprio leitor, D9) e `JOIN LATERAL` por
 * autor no índice `posts_author_type_pub_idx`. Contas excluídas saem na hora (A-11, FEED-12).
 * Datas saem em milissegundos (o `published_at` tem precisão de ms por CHECK), iguais nos dois
 * drivers (node-postgres e PGlite).
 */
@Injectable()
export class FeedRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  async page(query: FeedPageQuery): Promise<PostRecord[]> {
    const viewer = query.viewerId;
    const after =
      query.after === undefined
        ? sql``
        : sql`and (p.published_at, p.id) < (${query.after.at.toISOString()}::timestamptz, ${query.after.id}::uuid)`;
    const result = await this.database.db.execute(sql`
      with authors as (
        select c.user_b_id as id from connections c where c.user_a_id = ${viewer}
        union
        select c.user_a_id from connections c where c.user_b_id = ${viewer}
        union
        select f.creator_id from follows f where f.follower_id = ${viewer}
        union
        select ${viewer}::uuid
      )
      select p.id, p.author_id, u.handle as author_handle, u.name as author_name,
             u.avatar_key as author_avatar_key, u.account_type as author_type,
             p.type, p.status, p.text, p.caption, p.like_count, p.comment_count,
             floor(extract(epoch from p.created_at) * 1000)::bigint as created_ms,
             floor(extract(epoch from p.published_at) * 1000)::bigint as published_ms
        from authors a
        join users u on u.id = a.id and u.deleted_at is null
        cross join lateral (
          select * from posts p
           where p.author_id = a.id
             and p.type = ${query.type}
             and p.status = 'published'
             and p.deleted_at is null
             and p.published_at >= ${query.since.toISOString()}::timestamptz
             ${after}
           order by p.published_at desc nulls last, p.id desc nulls last
           limit ${query.limit}
        ) p
       order by p.published_at desc nulls last, p.id desc nulls last
       limit ${query.limit}
    `);
    return rowsOf<FeedRow>(result).map((row) => ({
      id: row.id,
      authorId: row.author_id,
      authorHandle: row.author_handle,
      authorName: row.author_name,
      authorAvatarKey: row.author_avatar_key,
      authorType: row.author_type,
      authorDeletedAt: null,
      type: row.type,
      status: row.status,
      text: row.text,
      caption: row.caption,
      likeCount: Number(row.like_count),
      commentCount: Number(row.comment_count),
      createdAt: new Date(Number(row.created_ms)),
      publishedAt: new Date(Number(row.published_ms)),
      deletedAt: null,
    }));
  }
}
