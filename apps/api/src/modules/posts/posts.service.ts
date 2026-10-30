import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { NewPostMediaRow, PostMediaRow } from '@sussurro/db';
import {
  type CreateDraftRequest,
  type CreateReelDraftRequest,
  type CreateTextPostRequest,
  type Draft,
  ErrorCode,
  type MediaMime,
  type Post,
  type ProfilePostsPage,
  type ProfilePostsQuery,
  type PublishPostRequest,
} from '@sussurro/shared';
import { z } from 'zod';

import { PostViewService } from './post-view.service.js';
import { type PostRecord, PostsRepository } from './posts.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { CursorCodec, invalidCursor } from '../../common/http/cursor.js';
import { RATE_LIMITS, RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { incomingKey, MediaService, type UploadSpec } from '../media/media.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';
import { UsersService } from '../users/users.service.js';

/**
 * O mesmo 404 para post inexistente, excluído, de conta excluída, sem permissão ou ainda não
 * publicado (para quem não é o autor): o corpo não revela se o post existe (PERM-13, PERM-14).
 */
export function postNotFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, 404, 'Publicação não encontrada');
}

const idSchema = z.uuid();

/** Chave do poster do reel em `incoming/`, ao lado do vídeo (o lifecycle apaga em 1 dia). */
export function posterIncomingKey(videoIncomingKey: string): string {
  return `${videoIncomingKey}-poster`;
}

/** O vídeo do reel com a duração declarada e o poster que o app vai enviar (D10). */
function reelMediaRow(row: NewPostMediaRow, input: CreateReelDraftRequest): NewPostMediaRow {
  return {
    ...row,
    durationS: input.video.durationS,
    posterIncomingKey: posterIncomingKey(row.incomingKey),
    posterMime: input.poster.mime,
    posterSizeBytes: input.poster.sizeBytes,
  };
}

/** O upload do poster de um vídeo, ou `null` (imagem, ou nenhuma mídia). */
function posterSpec(
  row: Pick<PostMediaRow, 'posterIncomingKey' | 'posterMime' | 'posterSizeBytes'> | undefined,
): UploadSpec | null {
  if (
    row === undefined ||
    row.posterIncomingKey === null ||
    row.posterMime === null ||
    row.posterSizeBytes === null
  ) {
    return null;
  }
  return {
    key: row.posterIncomingKey,
    mime: row.posterMime as MediaMime,
    sizeBytes: row.posterSizeBytes,
  };
}

/** Cursor das abas do perfil: conta, aba, chave de ordenação e id. */
const ProfileCursorSchema = z.object({
  u: z.uuid(),
  t: z.enum(['photo', 'text', 'reel']),
  a: z.int().nonnegative(),
  i: z.uuid(),
});
const PROFILE_CURSOR = 'profile-posts';

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    private readonly posts: PostsRepository,
    private readonly views: PostViewService,
    private readonly media: MediaService,
    private readonly policy: AccessPolicyService,
    private readonly users: UsersService,
    private readonly cursors: CursorCodec,
    private readonly rateLimiter: RateLimiterService,
    private readonly clock: Clock,
  ) {}

  /** Post pelo id, ou 404 se o id nem é um uuid (mesma resposta de inexistente). */
  private async findRecord(postId: string): Promise<PostRecord | undefined> {
    return idSchema.safeParse(postId).success ? this.posts.findById(postId) : undefined;
  }

  /** `POST /posts` (2.1): texto nasce publicado. */
  async createTextPost(viewer: AuthContext, input: CreateTextPostRequest): Promise<Post> {
    const id = await this.posts.insertTextPost({
      authorId: viewer.userId,
      text: input.text,
      now: this.clock.now(),
    });
    return this.getPost(viewer, id);
  }

  /**
   * `POST /posts/drafts` (2.2, ADR 0009; reel na 5.3, ADR 0006): cria o post `draft` e a mídia
   * `pending_upload` e devolve uma URL PUT pré-assinada por arquivo. O id de cada mídia é a chave no
   * S3. Reel: o vídeo (até 90 s e 200 MB, D10) e o poster gerado no app, cada um com a sua URL.
   */
  async createDraft(viewer: AuthContext, input: CreateDraftRequest): Promise<Draft> {
    await this.rateLimiter.consume(RATE_LIMITS.draftsPerUser, viewer.userId);
    if (input.type === 'reel') {
      // Custo do MediaConvert e do CDN (R10): um limite próprio, além do de rascunhos.
      await this.rateLimiter.consume(RATE_LIMITS.reelDraftsPerUser, viewer.userId);
    }
    const now = this.clock.now();
    const { postId, media } = await this.posts.db.transaction(async (tx) => {
      const id = await this.posts.insertDraft(tx, viewer.userId, input.type, now);
      const rows =
        input.type === 'photo'
          ? input.items.map((item, position) =>
              this.newMediaRow(viewer, id, now, { position, kind: 'image', ...item }),
            )
          : [
              reelMediaRow(
                this.newMediaRow(viewer, id, now, { kind: 'video', ...input.video }),
                input,
              ),
            ];
      return { postId: id, media: await this.posts.insertMedia(tx, rows) };
    });
    const uploads = await Promise.all(
      media.map(async (row) => ({
        mediaId: row.id,
        position: row.position,
        ...(await this.media.uploadTarget({
          key: row.incomingKey,
          mime: row.mime as MediaMime,
          sizeBytes: row.sizeBytes,
        })),
      })),
    );
    const poster = posterSpec(media[0]);
    return poster === null
      ? { postId, status: 'draft', uploads }
      : { postId, status: 'draft', uploads, poster: await this.media.uploadTarget(poster) };
  }

  private newMediaRow(
    viewer: AuthContext,
    postId: string,
    now: Date,
    item: { position?: number; kind: 'image' | 'video'; mime: MediaMime; sizeBytes: number },
  ): NewPostMediaRow {
    const mediaId = randomUUID();
    return {
      id: mediaId,
      postId,
      position: item.position ?? 0,
      kind: item.kind,
      mime: item.mime,
      sizeBytes: item.sizeBytes,
      incomingKey: incomingKey(viewer.userId, mediaId),
      status: 'pending_upload',
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * `POST /posts/:id/publish` (2.2, 5.3): confere cada objeto no S3 (HEAD: existe, tamanho e tipo
   * declarados; no reel, o vídeo e o poster), passa o post para `processing` e envia uma mensagem
   * por mídia à fila (`post-media` por imagem, `post-video` pelo vídeo). Repetir a chamada devolve o
   * estado atual (idempotente, MID-08). Rascunho de outra conta → 404.
   */
  async publish(viewer: AuthContext, postId: string, input: PublishPostRequest): Promise<Post> {
    const record = await this.findRecord(postId);
    if (
      record?.authorId !== viewer.userId ||
      record.deletedAt !== null ||
      record.authorDeletedAt !== null
    ) {
      throw postNotFound();
    }
    if (record.status !== 'draft') {
      return this.views.toPost(viewer, record);
    }

    const media = await this.posts.mediaOf([record.id]);
    const checks = await Promise.all(
      media.map(async (row) => {
        const poster = posterSpec(row);
        const [uploaded, posterUploaded] = await Promise.all([
          this.media.isUploaded({
            key: row.incomingKey,
            mime: row.mime as MediaMime,
            sizeBytes: row.sizeBytes,
          }),
          poster === null ? Promise.resolve(true) : this.media.isUploaded(poster),
        ]);
        return { position: row.position, uploaded, posterUploaded };
      }),
    );
    const missing = checks.filter((check) => !check.uploaded).map((check) => check.position);
    const posterMissing = checks.some((check) => !check.posterUploaded);
    if (media.length === 0 || missing.length > 0 || posterMissing) {
      throw new DomainError(
        ErrorCode.MEDIA_NOT_UPLOADED,
        409,
        record.type === 'reel'
          ? 'O vídeo ou a capa não foram enviados'
          : 'Há fotos que não foram enviadas',
        record.type === 'reel'
          ? { positions: missing, poster: posterMissing }
          : { positions: missing },
      );
    }

    const now = this.clock.now();
    const changed = await this.posts.db.transaction((tx) =>
      this.posts.markProcessing(tx, record.id, input.caption, now),
    );
    if (changed) {
      try {
        await this.media.enqueue(
          media.map((row) =>
            row.kind === 'video'
              ? { type: 'post-video', mediaId: row.id }
              : { type: 'post-media', mediaId: row.id },
          ),
        );
      } catch (error) {
        // Sem a fila o post ficaria preso em processing: volta a rascunho e o app tenta de novo.
        this.logger.error(`Falha ao enfileirar a publicação: ${describeError(error)}`);
        await this.posts.revertToDraft(record.id, now);
        throw new DomainError(
          ErrorCode.SERVICE_UNAVAILABLE,
          503,
          'Processamento indisponível; tente de novo',
        );
      }
    }
    return this.getPost(viewer, record.id);
  }

  /** `GET /posts/:id`: só para quem passa no `AccessPolicyService` (PERM-14, MID-09). */
  async getPost(viewer: AuthContext, postId: string): Promise<Post> {
    const record = await this.findVisible(viewer, postId);
    return this.views.toPost(viewer, record);
  }

  /** Post que o leitor pode ver, ou o 404 padrão. */
  async findVisible(viewer: AuthContext, postId: string): Promise<PostRecord> {
    const record = await this.findRecord(postId);
    if (record === undefined || !(await this.policy.canViewPost(viewer, record))) {
      throw postNotFound();
    }
    return record;
  }

  /**
   * Post em que dá para curtir e comentar: visível e publicado. Para quem não vê, o mesmo 404 do
   * detalhe (PERM-14); o próprio post ainda processando também dá 404.
   */
  async findInteractable(viewer: AuthContext, postId: string): Promise<PostRecord> {
    const record = await this.findVisible(viewer, postId);
    if (record.status !== 'published') {
      throw postNotFound();
    }
    return record;
  }

  /** `DELETE /posts/:id` (2.9): só o autor; para os outros, 404 (2.9 CA2). */
  async deletePost(viewer: AuthContext, postId: string): Promise<void> {
    const record = await this.findRecord(postId);
    if (record?.authorId !== viewer.userId || record.authorDeletedAt !== null) {
      throw postNotFound();
    }
    if (!(await this.posts.softDelete(record.id, viewer.userId, this.clock.now()))) {
      throw postNotFound();
    }
  }

  /**
   * `GET /users/:handle/posts?type=` (2.6): a mesma regra e o mesmo 404 de `GET /users/:handle`.
   * O dono vê também os posts em processamento e com falha (MID-09).
   */
  async listProfilePosts(
    viewer: AuthContext,
    handle: string,
    query: ProfilePostsQuery,
  ): Promise<ProfilePostsPage> {
    const author = await this.users.findVisibleProfile(viewer, handle);
    let after: { at: Date; id: string } | undefined;
    if (query.cursor !== undefined) {
      const cursor = this.cursors.decode(PROFILE_CURSOR, query.cursor, ProfileCursorSchema);
      if (cursor.u !== author.id || cursor.t !== query.type) {
        throw invalidCursor();
      }
      after = { at: new Date(cursor.a), id: cursor.i };
    }
    const rows = await this.posts.listByAuthor({
      authorId: author.id,
      type: query.type,
      includePending: author.id === viewer.userId,
      after,
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? this.cursors.encode(PROFILE_CURSOR, {
            u: author.id,
            t: query.type,
            a: last.sortAt.getTime(),
            i: last.id,
          })
        : null;
    return { items: await this.views.toPosts(viewer, page), nextCursor };
  }
}
