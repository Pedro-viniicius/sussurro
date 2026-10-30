// Ajudantes dos e2e da Fase 2: rascunho, upload no S3 em memória, publicação e o "worker" simulado.
import { and, eq, postMedia, posts } from '@sussurro/db';
import { type CreateUserOptions } from '@sussurro/db/testing';
import {
  type CreateReelDraftRequest,
  type Draft,
  DraftSchema,
  type MediaItemRequest,
  type Post,
  PostSchema,
} from '@sussurro/shared';

import { signedInUser } from './auth.js';
import type { TestApp } from './test-app.js';

/** Conta com o e-mail confirmado (a Fase 2 exige para publicar e comentar, X.3). */
export function verifiedUser(t: TestApp, options: CreateUserOptions = {}) {
  return signedInUser(t.http, t.database.db, { emailVerifiedAt: new Date(), ...options });
}

export function jpegItems(count: number, sizeBytes = 1024): MediaItemRequest[] {
  return Array.from({ length: count }, () => ({ mime: 'image/jpeg', sizeBytes }));
}

export async function createDraftViaApi(
  t: TestApp,
  headers: Record<string, string>,
  items: MediaItemRequest[] = jpegItems(1),
): Promise<Draft> {
  const response = await t.http
    .post('/v1/posts/drafts')
    .set(headers)
    .send({ type: 'photo', items })
    .expect(201);
  return DraftSchema.parse(response.body);
}

/** Faz o PUT de cada imagem do rascunho, com o tamanho e o tipo declarados. */
export function uploadDraft(t: TestApp, draft: Draft): void {
  for (const upload of draft.uploads) {
    const size = Number(upload.headers['Content-Length']);
    const result = t.storage.upload(
      upload.url,
      Buffer.alloc(size, 7),
      upload.headers['Content-Type'],
    );
    if (result.status !== 200) {
      throw new Error(`upload recusado: ${String(result.code)}`);
    }
  }
}

/** Rascunho + upload + publish: o post fica em `processing`. */
export async function publishPhotoViaApi(
  t: TestApp,
  headers: Record<string, string>,
  options: { count?: number; caption?: string } = {},
): Promise<Post> {
  const draft = await createDraftViaApi(t, headers, jpegItems(options.count ?? 1));
  uploadDraft(t, draft);
  const response = await t.http
    .post(`/v1/posts/${draft.postId}/publish`)
    .set(headers)
    .send(options.caption === undefined ? {} : { caption: options.caption })
    .expect(200);
  return PostSchema.parse(response.body);
}

/**
 * Faz o papel do worker (testado no apps/worker): imagens `ready` com as chaves de saída e o post
 * `published` no horário do relógio de teste.
 */
export async function completeProcessing(t: TestApp, postId: string): Promise<void> {
  const media = await t.database.db.select().from(postMedia).where(eq(postMedia.postId, postId));
  for (const item of media) {
    await t.database.db
      .update(postMedia)
      .set({
        status: 'ready',
        storageKey: `media/${item.id}/full.jpg`,
        thumbKey: `media/${item.id}/thumb.jpg`,
        width: 1080,
        height: 1350,
        updatedAt: t.clock.now(),
      })
      .where(eq(postMedia.id, item.id));
  }
  await t.database.db
    .update(posts)
    .set({ status: 'published', publishedAt: t.clock.now() })
    .where(and(eq(posts.id, postId), eq(posts.status, 'processing')));
}

/** Post de texto pela API (exige e-mail confirmado). */
export async function createTextPostViaApi(
  t: TestApp,
  headers: Record<string, string>,
  text = 'Um sussurro de teste',
): Promise<Post> {
  const response = await t.http
    .post('/v1/posts')
    .set(headers)
    .send({ type: 'text', text })
    .expect(201);
  return PostSchema.parse(response.body);
}

// --- reels (Fase 5) -------------------------------------------------------------------------------

/** Corpo de `POST /posts/drafts` de um reel (D10: até 90 s e 200 MB), com o poster do app. */
export function reelDraftBody(
  video: Partial<CreateReelDraftRequest['video']> = {},
  poster: Partial<CreateReelDraftRequest['poster']> = {},
) {
  return {
    type: 'reel',
    video: { mime: 'video/mp4', sizeBytes: 4096, durationS: 42.5, ...video },
    poster: { mime: 'image/jpeg', sizeBytes: 512, ...poster },
  };
}

export async function createReelDraftViaApi(
  t: TestApp,
  headers: Record<string, string>,
  body: ReturnType<typeof reelDraftBody> = reelDraftBody(),
): Promise<Draft> {
  const response = await t.http.post('/v1/posts/drafts').set(headers).send(body).expect(201);
  return DraftSchema.parse(response.body);
}

/** PUT do vídeo e (se `poster` não for `false`) do poster, com o tipo e o tamanho assinados. */
export function uploadReel(t: TestApp, draft: Draft, options: { poster?: boolean } = {}): void {
  uploadDraft(t, draft);
  if (options.poster === false || draft.poster === undefined) {
    return;
  }
  const result = t.storage.upload(
    draft.poster.url,
    Buffer.alloc(Number(draft.poster.headers['Content-Length']), 9),
    draft.poster.headers['Content-Type'],
  );
  if (result.status !== 200) {
    throw new Error(`upload do poster recusado: ${String(result.code)}`);
  }
}

/** Rascunho + upload + publish de um reel: o post fica em `processing` ("processando"). */
export async function publishReelViaApi(
  t: TestApp,
  headers: Record<string, string>,
  options: { caption?: string } = {},
): Promise<Post> {
  const draft = await createReelDraftViaApi(t, headers);
  uploadReel(t, draft);
  const response = await t.http
    .post(`/v1/posts/${draft.postId}/publish`)
    .set(headers)
    .send(options.caption === undefined ? {} : { caption: options.caption })
    .expect(200);
  return PostSchema.parse(response.body);
}

/**
 * Faz o papel do worker com o `VideoProcessor` (testado no apps/worker): o vídeo `ready` com o MP4,
 * o poster e a duração medida, e o post `published` no horário do relógio de teste.
 */
export async function completeReelProcessing(
  t: TestApp,
  postId: string,
  durationS = 42.48,
): Promise<void> {
  const [media] = await t.database.db.select().from(postMedia).where(eq(postMedia.postId, postId));
  if (media === undefined) {
    throw new Error('reel sem mídia');
  }
  await t.database.db
    .update(postMedia)
    .set({
      status: 'ready',
      storageKey: `media/${media.id}/video.mp4`,
      thumbKey: `media/${media.id}/poster.jpg`,
      width: 720,
      height: 1280,
      durationS,
      processorJobId: `passthrough:${media.id}`,
      updatedAt: t.clock.now(),
    })
    .where(eq(postMedia.id, media.id));
  await t.database.db
    .update(posts)
    .set({ status: 'published', publishedAt: t.clock.now() })
    .where(and(eq(posts.id, postId), eq(posts.status, 'processing')));
}

/** O worker desistiu (MediaConvert ERROR, vídeo longo demais, 3 tentativas): post `failed`. */
export async function failProcessing(t: TestApp, postId: string): Promise<void> {
  await t.database.db
    .update(postMedia)
    .set({ status: 'failed', error: 'MediaConvert 1040: falha simulada', updatedAt: t.clock.now() })
    .where(eq(postMedia.postId, postId));
  await t.database.db
    .update(posts)
    .set({ status: 'failed' })
    .where(and(eq(posts.id, postId), eq(posts.status, 'processing')));
}
