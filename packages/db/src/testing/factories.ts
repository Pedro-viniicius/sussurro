import { randomBytes, randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import type { DbExecutor } from '../client.ts';
import {
  blocks,
  type CommentRow,
  comments,
  connections,
  follows,
  likes,
  type MediaKindValue,
  type MediaStatusValue,
  postMedia,
  type PostMediaRow,
  type PostRow,
  posts,
  type PostStatusValue,
  type PostTypeValue,
  users,
  type UserRow,
} from '../schema/index.ts';

/** Senha das contas criadas pelas factories (passa na política de senha). */
export const TEST_PASSWORD = 'senha-de-teste-1';

/**
 * argon2id de `TEST_PASSWORD` com os parâmetros da API (m=19456, t=2, p=1). Pré-calculado para os
 * testes não pagarem o hash a cada conta; qualquer implementação de argon2 verifica o PHC.
 */
export const TEST_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$us1IAd3q2Lm86ZMvgoL5qg$2EyqYbpqvKDDSdNQfBboOlVuC6S/uRpIBXsvTfFLscI';

export interface CreateUserOptions {
  handle?: string;
  email?: string;
  name?: string;
  bio?: string | null;
  accountType?: 'personal' | 'creator';
  passwordHash?: string;
  emailVerifiedAt?: Date | null;
  createdAt?: Date;
  deletedAt?: Date | null;
}

let sequence = 0;

/** Cria uma conta direto no banco (testes.md §2.2). Valores únicos por padrão. */
export async function createUser(
  db: DbExecutor,
  options: CreateUserOptions = {},
): Promise<UserRow> {
  sequence += 1;
  const suffix = `${String(sequence)}_${randomBytes(3).toString('hex')}`;
  const handle = options.handle ?? `pessoa${suffix}`;
  const createdAt = options.createdAt ?? new Date();
  const [row] = await db
    .insert(users)
    .values({
      handle,
      email: options.email ?? `${handle.toLowerCase()}@example.com`,
      name: options.name ?? `Pessoa ${String(sequence)}`,
      bio: options.bio ?? null,
      accountType: options.accountType ?? 'personal',
      passwordHash: options.passwordHash ?? TEST_PASSWORD_HASH,
      emailVerifiedAt: options.emailVerifiedAt ?? null,
      createdAt,
      updatedAt: createdAt,
      deletedAt: options.deletedAt ?? null,
    })
    .returning();
  if (row === undefined) {
    throw new Error('createUser: o INSERT não devolveu a linha');
  }
  return row;
}

/** Conecta duas contas pessoais (par ordenado, como o servidor grava na Fase 4). */
export async function connect(
  db: DbExecutor,
  first: Pick<UserRow, 'id'>,
  second: Pick<UserRow, 'id'>,
  options: { method?: 'ble' | 'qr'; createdAt?: Date } = {},
): Promise<void> {
  const [userAId, userBId] = first.id < second.id ? [first.id, second.id] : [second.id, first.id];
  await db.insert(connections).values({
    userAId,
    userBId,
    method: options.method ?? 'ble',
    createdAt: options.createdAt ?? new Date(),
  });
}

/**
 * Bloqueio direto no banco (X.2), como o seed. Não desfaz relações: para o efeito completo
 * (conexão e follows desfeitos), use a rota `POST /me/blocks`.
 */
export async function block(
  db: DbExecutor,
  blocker: Pick<UserRow, 'id'>,
  blocked: Pick<UserRow, 'id'>,
  options: { createdAt?: Date } = {},
): Promise<void> {
  await db.insert(blocks).values({
    blockerId: blocker.id,
    blockedId: blocked.id,
    createdAt: options.createdAt ?? new Date(),
  });
}

/** Pessoa segue criador (rotas na Fase 3). */
export async function follow(
  db: DbExecutor,
  person: Pick<UserRow, 'id'>,
  creator: Pick<UserRow, 'id'>,
  options: { createdAt?: Date } = {},
): Promise<void> {
  await db.insert(follows).values({
    followerId: person.id,
    creatorId: creator.id,
    createdAt: options.createdAt ?? new Date(),
  });
}

export interface CreatePostOptions {
  type?: PostTypeValue;
  status?: PostStatusValue;
  text?: string;
  caption?: string | null;
  createdAt?: Date;
  /** Padrão: `createdAt` quando o status é `published`. */
  publishedAt?: Date | null;
  deletedAt?: Date | null;
  /** Fotos do post (padrão 1 em `photo`). Ficam `ready` se o post estiver publicado. */
  mediaCount?: number;
  /** Status das fotos (padrão: `ready` em post publicado, `processing` em processando…). */
  mediaStatus?: MediaStatusValue;
}

export interface CreatedPost extends PostRow {
  media: PostMediaRow[];
}

const MEDIA_STATUS_BY_POST: Record<PostStatusValue, MediaStatusValue> = {
  draft: 'pending_upload',
  processing: 'processing',
  published: 'ready',
  failed: 'failed',
};

let postSequence = 0;

/**
 * Cria um post direto no banco (testes.md §2.2). Texto nasce publicado; foto ganha `mediaCount`
 * imagens com as chaves do S3 no formato do worker (`media/{id}/full.jpg`).
 */
export async function createPost(
  db: DbExecutor,
  author: Pick<UserRow, 'id'>,
  options: CreatePostOptions = {},
): Promise<CreatedPost> {
  postSequence += 1;
  const type = options.type ?? 'text';
  const status = options.status ?? 'published';
  const createdAt = options.createdAt ?? new Date();
  const publishedAt =
    options.publishedAt === undefined
      ? status === 'published'
        ? createdAt
        : null
      : options.publishedAt;
  const [post] = await db
    .insert(posts)
    .values({
      authorId: author.id,
      type,
      status,
      text: type === 'text' ? (options.text ?? `Post de teste ${String(postSequence)}`) : null,
      caption: type === 'text' ? null : (options.caption ?? null),
      createdAt,
      publishedAt,
      deletedAt: options.deletedAt ?? null,
    })
    .returning();
  if (post === undefined) {
    throw new Error('createPost: o INSERT não devolveu a linha');
  }
  // Reel (Fase 5): sempre um vídeo, na posição 0.
  const mediaCount = options.mediaCount ?? (type === 'photo' || type === 'reel' ? 1 : 0);
  const mediaStatus = options.mediaStatus ?? MEDIA_STATUS_BY_POST[status];
  const media: PostMediaRow[] = [];
  for (let position = 0; position < mediaCount; position++) {
    media.push(
      await createPostMedia(db, post, author, {
        position,
        status: mediaStatus,
        kind: type === 'reel' ? 'video' : 'image',
      }),
    );
  }
  return { ...post, media };
}

export interface CreatePostMediaOptions {
  position?: number;
  status?: MediaStatusValue;
  /** `video` só no reel (Fase 5): MP4 + poster, com duração. */
  kind?: MediaKindValue;
  mime?: string;
  sizeBytes?: number;
  durationS?: number;
}

/**
 * Uma imagem de post ou o vídeo de um reel. Com `status = ready`, já tem as chaves e o tamanho de
 * saída do worker (`full.jpg`/`thumb.jpg`; no vídeo, `video.mp4`/`poster.jpg`, 720×1280).
 */
export async function createPostMedia(
  db: DbExecutor,
  post: Pick<PostRow, 'id' | 'createdAt'>,
  author: Pick<UserRow, 'id'>,
  options: CreatePostMediaOptions = {},
): Promise<PostMediaRow> {
  const id = randomUUID();
  const status = options.status ?? 'ready';
  const ready = status === 'ready';
  const video = options.kind === 'video';
  const incomingKey = `incoming/${author.id}/${id}`;
  const [row] = await db
    .insert(postMedia)
    .values({
      id,
      postId: post.id,
      position: options.position ?? 0,
      kind: video ? 'video' : 'image',
      mime: options.mime ?? (video ? 'video/mp4' : 'image/jpeg'),
      sizeBytes: options.sizeBytes ?? (video ? 1_000_000 : 1024),
      incomingKey,
      storageKey: ready ? `media/${id}/${video ? 'video.mp4' : 'full.jpg'}` : null,
      thumbKey: ready ? `media/${id}/${video ? 'poster.jpg' : 'thumb.jpg'}` : null,
      width: ready ? (video ? 720 : 1080) : null,
      height: ready ? (video ? 1280 : 1350) : null,
      durationS: video ? (options.durationS ?? 42) : null,
      posterIncomingKey: video ? `${incomingKey}-poster` : null,
      posterMime: video ? 'image/jpeg' : null,
      posterSizeBytes: video ? 2048 : null,
      status,
      createdAt: post.createdAt,
      updatedAt: post.createdAt,
    })
    .returning();
  if (row === undefined) {
    throw new Error('createPostMedia: o INSERT não devolveu a linha');
  }
  return row;
}

/** Curtida com o contador desnormalizado ajustado (como a API faz). */
export async function addLike(
  db: DbExecutor,
  post: Pick<PostRow, 'id'>,
  user: Pick<UserRow, 'id'>,
): Promise<void> {
  await db.insert(likes).values({ postId: post.id, userId: user.id });
  await db
    .update(posts)
    .set({ likeCount: sql`${posts.likeCount} + 1` })
    .where(eq(posts.id, post.id));
}

/** Comentário (ou resposta, com `parentId`) com o contador ajustado (como a API faz). */
export async function addComment(
  db: DbExecutor,
  post: Pick<PostRow, 'id'>,
  author: Pick<UserRow, 'id'>,
  options: { body?: string; parentId?: string; createdAt?: Date } = {},
): Promise<CommentRow> {
  const [row] = await db
    .insert(comments)
    .values({
      postId: post.id,
      authorId: author.id,
      parentId: options.parentId ?? null,
      body: options.body ?? 'Comentário de teste',
      createdAt: options.createdAt ?? new Date(),
    })
    .returning();
  if (row === undefined) {
    throw new Error('addComment: o INSERT não devolveu a linha');
  }
  await db
    .update(posts)
    .set({ commentCount: sql`${posts.commentCount} + 1` })
    .where(eq(posts.id, post.id));
  return row;
}
