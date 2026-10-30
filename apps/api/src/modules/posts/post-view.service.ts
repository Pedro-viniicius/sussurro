import { Injectable } from '@nestjs/common';
import type { PostMediaRow } from '@sussurro/db';
import type { Post, PostMedia } from '@sussurro/shared';

import type { PostRecord } from './posts.repository.js';
import { PostsRepository } from './posts.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { MediaService } from '../media/media.service.js';

/**
 * Monta o `Post` da API a partir de linhas já autorizadas pelo `AccessPolicyService` (detalhe,
 * feed e perfil): mídia `ready` com URLs assinadas, `likedByMe` e o autor. Consultas em lote: uma
 * para a mídia e uma para as curtidas do leitor, qualquer que seja o tamanho da página.
 */
@Injectable()
export class PostViewService {
  constructor(
    private readonly posts: PostsRepository,
    private readonly media: MediaService,
  ) {}

  async toPosts(viewer: AuthContext, records: readonly PostRecord[]): Promise<Post[]> {
    if (records.length === 0) {
      return [];
    }
    const ids = records.map((record) => record.id);
    const [mediaRows, liked] = await Promise.all([
      this.posts.mediaOf(ids),
      // Criador não curte (A-06): `likedByMe` é sempre `false` para ele.
      viewer.accountType === 'personal'
        ? this.posts.likedBy(viewer.userId, ids)
        : Promise.resolve(new Set<string>()),
    ]);
    const mediaByPost = new Map<string, PostMediaRow[]>();
    for (const row of mediaRows) {
      const list = mediaByPost.get(row.postId) ?? [];
      list.push(row);
      mediaByPost.set(row.postId, list);
    }
    return Promise.all(
      records.map(async (record) => ({
        id: record.id,
        type: record.type,
        status: record.status,
        author: {
          handle: record.authorHandle,
          name: record.authorName,
          avatarUrl: await this.media.signUrl(record.authorAvatarKey),
          accountType: record.authorType,
        },
        isOwn: record.authorId === viewer.userId,
        text: record.text,
        caption: record.caption,
        media: await Promise.all(
          (mediaByPost.get(record.id) ?? []).map((row) => this.toMedia(row)),
        ),
        likeCount: record.likeCount,
        commentCount: record.commentCount,
        likedByMe: liked.has(record.id),
        createdAt: record.createdAt.toISOString(),
        publishedAt: record.publishedAt?.toISOString() ?? null,
      })),
    );
  }

  async toPost(viewer: AuthContext, record: PostRecord): Promise<Post> {
    const [post] = await this.toPosts(viewer, [record]);
    if (post === undefined) {
      throw new Error('toPosts não devolveu o post');
    }
    return post;
  }

  /**
   * Só mídia `ready` recebe URL (FEED-15): processando ou com falha, nada é servido (MID-04, MID-09),
   * nem o poster do reel. No vídeo, `url` é o MP4, `thumbUrl` o poster e `durationS` a duração
   * medida pelo worker.
   */
  private async toMedia(row: PostMediaRow): Promise<PostMedia> {
    const ready = row.status === 'ready';
    return {
      id: row.id,
      kind: row.kind,
      position: row.position,
      status: row.status,
      width: ready ? row.width : null,
      height: ready ? row.height : null,
      durationS: ready && row.kind === 'video' ? row.durationS : null,
      url: ready ? await this.media.signUrl(row.storageKey) : null,
      thumbUrl: ready ? await this.media.signUrl(row.thumbKey) : null,
    };
  }
}
