import {
  type AvatarStatus,
  AvatarStatusSchema,
  type AvatarUpload,
  AvatarUploadSchema,
  type Comment,
  type CommentsPage,
  CommentsPageSchema,
  CommentSchema,
  type CreateCommentInput,
  type CreateDraftInput,
  type Draft,
  DraftSchema,
  type FeedPage,
  FeedPageSchema,
  type LikeState,
  LikeStateSchema,
  type MediaItemRequest,
  NoContentSchema,
  PAGE_SIZE_DEFAULT,
  type Post,
  PostSchema,
  type PostType,
  type ProfilePostsPage,
  ProfilePostsPageSchema,
  type PublicProfile,
  PublicProfileSchema,
  type ReelPosterRequest,
  type ReelVideoRequest,
} from '@sussurro/shared';

import type { ApiClient } from '../../lib/api/client';
import { withQuery } from '../../lib/api/query';

/**
 * Rotas da Fase 2 (contrato em packages/shared: posts.ts, feed.ts, media.ts). Toda resposta passa
 * pelo schema Zod; o `code` dos erros escolhe a mensagem em `lib/error-messages.ts`.
 */

const id = (value: string) => encodeURIComponent(value);

export function fetchFeedPage(api: ApiClient, type: PostType, cursor?: string): Promise<FeedPage> {
  return api.request(withQuery('/v1/feed', { type, cursor, limit: PAGE_SIZE_DEFAULT }), {
    schema: FeedPageSchema,
  });
}

export function fetchProfilePosts(
  api: ApiClient,
  handle: string,
  type: PostType,
  cursor?: string,
): Promise<ProfilePostsPage> {
  return api.request(
    withQuery(`/v1/users/${id(handle)}/posts`, { type, cursor, limit: PAGE_SIZE_DEFAULT }),
    { schema: ProfilePostsPageSchema },
  );
}

export function fetchProfile(api: ApiClient, handle: string): Promise<PublicProfile> {
  return api.request(`/v1/users/${id(handle)}`, { schema: PublicProfileSchema });
}

export function fetchPost(api: ApiClient, postId: string): Promise<Post> {
  return api.request(`/v1/posts/${id(postId)}`, { schema: PostSchema });
}

export function createTextPost(api: ApiClient, text: string): Promise<Post> {
  return api.request('/v1/posts', {
    method: 'POST',
    body: { type: 'text', text },
    schema: PostSchema,
  });
}

export function createDraft(api: ApiClient, items: MediaItemRequest[]): Promise<Draft> {
  const body: CreateDraftInput = { type: 'photo', items };
  return api.request('/v1/posts/drafts', { method: 'POST', body, schema: DraftSchema });
}

/**
 * Rascunho de reel (5.3, contrato da 5a): o vídeo (tipo, tamanho exato e duração do seletor) e a
 * capa gerada no app. Volta com a URL do vídeo em `uploads[0]` e a da capa em `poster`.
 */
export function createReelDraft(
  api: ApiClient,
  input: { video: ReelVideoRequest; poster: ReelPosterRequest },
): Promise<Draft> {
  const body: CreateDraftInput = { type: 'reel', video: input.video, poster: input.poster };
  return api.request('/v1/posts/drafts', { method: 'POST', body, schema: DraftSchema });
}

export function publishPost(api: ApiClient, postId: string, caption: string | null): Promise<Post> {
  return api.request(`/v1/posts/${id(postId)}/publish`, {
    method: 'POST',
    body: caption === null ? {} : { caption },
    schema: PostSchema,
  });
}

export function deletePost(api: ApiClient, postId: string): Promise<undefined> {
  return api.request(`/v1/posts/${id(postId)}`, { method: 'DELETE', schema: NoContentSchema });
}

export function setLike(api: ApiClient, postId: string, liked: boolean): Promise<LikeState> {
  return api.request(`/v1/posts/${id(postId)}/like`, {
    method: liked ? 'PUT' : 'DELETE',
    schema: LikeStateSchema,
  });
}

export function fetchComments(
  api: ApiClient,
  postId: string,
  cursor?: string,
): Promise<CommentsPage> {
  return api.request(
    withQuery(`/v1/posts/${id(postId)}/comments`, { cursor, limit: PAGE_SIZE_DEFAULT }),
    { schema: CommentsPageSchema },
  );
}

export function createComment(
  api: ApiClient,
  postId: string,
  input: CreateCommentInput,
): Promise<Comment> {
  return api.request(`/v1/posts/${id(postId)}/comments`, {
    method: 'POST',
    body: input,
    schema: CommentSchema,
  });
}

export function deleteComment(api: ApiClient, commentId: string): Promise<undefined> {
  return api.request(`/v1/comments/${id(commentId)}`, {
    method: 'DELETE',
    schema: NoContentSchema,
  });
}

export function requestAvatarUpload(api: ApiClient, item: MediaItemRequest): Promise<AvatarUpload> {
  return api.request('/v1/me/avatar/upload-url', {
    method: 'POST',
    body: item,
    schema: AvatarUploadSchema,
  });
}

export function setAvatar(api: ApiClient, uploadId: string): Promise<AvatarStatus> {
  return api.request('/v1/me/avatar', {
    method: 'PUT',
    body: { uploadId },
    schema: AvatarStatusSchema,
  });
}

export function removeAvatar(api: ApiClient): Promise<undefined> {
  return api.request('/v1/me/avatar', { method: 'DELETE', schema: NoContentSchema });
}
