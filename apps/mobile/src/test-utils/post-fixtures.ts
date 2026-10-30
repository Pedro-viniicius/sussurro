import type {
  Comment,
  CommentThread,
  Draft,
  FeedPage,
  Post,
  PostAuthor,
  PostMedia,
} from '@sussurro/shared';

/** Fixtures dos posts da Fase 2 nos testes do app (formato exato dos schemas de packages/shared). */

let sequence = 0;

/** UUID v7 de mentira, único por chamada (o schema exige UUID). */
export function uuid(): string {
  sequence += 1;
  const hex = sequence.toString(16).padStart(12, '0');
  return `01a189e0-af57-7000-8000-${hex}`;
}

export const AUTHORS = {
  marinac: {
    handle: 'marinac',
    name: 'Marina Costa',
    avatarUrl: null,
    accountType: 'personal',
  },
  juprado: {
    handle: 'juprado',
    name: 'Juliana Prado',
    avatarUrl: null,
    accountType: 'personal',
  },
  cozinhadabia: {
    handle: 'cozinhadabia',
    name: 'Beatriz Lemos',
    avatarUrl: null,
    accountType: 'creator',
  },
  helena: {
    handle: 'helena',
    name: 'Helena Souza',
    avatarUrl: null,
    accountType: 'personal',
  },
} as const satisfies Record<string, PostAuthor>;

const ISO = '2026-10-29T12:00:00.000Z';

export function media(position: number, overrides: Partial<PostMedia> = {}): PostMedia {
  const id = uuid();
  return {
    id,
    // Fase 5 (contrato dos reels): a mídia diz se é imagem ou vídeo e traz a duração do vídeo.
    kind: 'image',
    position,
    status: 'ready',
    width: 1080,
    height: 1350,
    durationS: null,
    url: `https://cdn.teste/media/${id}/full.jpg`,
    thumbUrl: `https://cdn.teste/media/${id}/thumb.jpg`,
    ...overrides,
  };
}

export function photoPost(overrides: Partial<Post> = {}): Post {
  return {
    id: uuid(),
    type: 'photo',
    status: 'published',
    author: AUTHORS.marinac,
    isOwn: false,
    text: null,
    caption: 'Domingo de manhã no Passaúna.',
    media: [media(0), media(1)],
    likeCount: 6,
    commentCount: 2,
    likedByMe: false,
    createdAt: ISO,
    publishedAt: ISO,
    ...overrides,
  };
}

export function textPost(overrides: Partial<Post> = {}): Post {
  return {
    id: uuid(),
    type: 'text',
    status: 'published',
    author: AUTHORS.juprado,
    isOwn: false,
    text: 'Alguém mais tentou ficar uma semana sem abrir o celular antes do café?',
    caption: null,
    media: [],
    likeCount: 4,
    commentCount: 1,
    likedByMe: false,
    createdAt: ISO,
    publishedAt: ISO,
    ...overrides,
  };
}

export function feedPage(items: Post[], overrides: Partial<FeedPage> = {}): FeedPage {
  return { items, nextCursor: null, caughtUp: true, windowHours: 72, ...overrides };
}

export function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: uuid(),
    parentId: null,
    body: 'Que luz bonita!',
    createdAt: ISO,
    author: { ...AUTHORS.juprado, profileVisible: true },
    canDelete: false,
    ...overrides,
  };
}

export function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return { ...comment(), replies: [], ...overrides };
}

/** Rascunho com uma URL PUT por foto, como o `POST /posts/drafts` devolve. */
export function draft(
  sizes: number[],
  {
    expiresAt = '2099-01-01T00:00:00.000Z',
    postId = uuid(),
  }: { expiresAt?: string; postId?: string } = {},
): Draft {
  return {
    postId,
    status: 'draft',
    uploads: sizes.map((size, position) => ({
      mediaId: uuid(),
      position,
      method: 'PUT' as const,
      url: `https://s3.teste/incoming/${postId}/${String(position)}?X-Amz-Signature=abc`,
      headers: { 'Content-Type': 'image/jpeg' as const, 'Content-Length': String(size) },
      expiresAt,
    })),
  };
}

/** O vídeo de um reel pronto (Fase 5): MP4 em `url`, o poster em `thumbUrl`, a duração medida. */
export function videoMedia(overrides: Partial<PostMedia> = {}): PostMedia {
  const id = uuid();
  return {
    id,
    kind: 'video',
    position: 0,
    status: 'ready',
    width: 720,
    height: 1280,
    durationS: 42,
    url: `https://cdn.teste/media/${id}/video.mp4`,
    thumbUrl: `https://cdn.teste/media/${id}/poster.jpg`,
    ...overrides,
  };
}

/** O vídeo ainda processando (ou com falha): sem URL nem duração (contrato da 5a). */
export function pendingVideo(status: 'processing' | 'failed' = 'processing'): PostMedia {
  return videoMedia({
    status,
    width: null,
    height: null,
    durationS: null,
    url: null,
    thumbUrl: null,
  });
}

export function reelPost(overrides: Partial<Post> = {}): Post {
  return {
    id: uuid(),
    type: 'reel',
    status: 'published',
    author: AUTHORS.marinac,
    isOwn: false,
    text: null,
    caption: 'Fim de tarde no Passaúna.',
    media: [videoMedia()],
    likeCount: 3,
    commentCount: 1,
    likedByMe: false,
    createdAt: ISO,
    publishedAt: ISO,
    ...overrides,
  };
}

/** Rascunho de reel como o `POST /posts/drafts` devolve: o vídeo em `uploads[0]` e a capa em `poster`. */
export function reelDraft({
  videoSize,
  videoMime = 'video/quicktime',
  posterSize,
  postId = uuid(),
  expiresAt = '2099-01-01T00:00:00.000Z',
}: {
  videoSize: number;
  videoMime?: 'video/mp4' | 'video/quicktime';
  posterSize: number;
  postId?: string;
  expiresAt?: string;
}): Draft {
  return {
    postId,
    status: 'draft',
    uploads: [
      {
        mediaId: uuid(),
        position: 0,
        method: 'PUT',
        url: `https://s3.teste/incoming/${postId}/video?X-Amz-Signature=abc`,
        headers: { 'Content-Type': videoMime, 'Content-Length': String(videoSize) },
        expiresAt,
      },
    ],
    poster: {
      method: 'PUT',
      url: `https://s3.teste/incoming/${postId}/poster?X-Amz-Signature=def`,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(posterSize) },
      expiresAt,
    },
  };
}
