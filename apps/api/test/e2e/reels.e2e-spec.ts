// E2E dos reels no servidor (Fase 5a: histórias 5.3 e 5.6 no lado da API; D10; MID-09, MID-10,
// MID-14, FEED-05 e PERM-14 para reels). O worker é simulado pelos ajudantes de `support/posts.ts`
// (o `VideoProcessor` é testado no apps/worker).
import { eq, postMedia, posts } from '@sussurro/db';
import { connect, createPost, createUser, follow } from '@sussurro/db/testing';
import {
  DraftSchema,
  ErrorResponseSchema,
  FeedPageSchema,
  MAX_POSTER_BYTES,
  MAX_VIDEO_BYTES,
  MediaJobMessageSchema,
  MeSchema,
  PostSchema,
  ProfilePostsPageSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signedInUser } from '../support/auth.js';
import {
  completeReelProcessing,
  createReelDraftViaApi,
  failProcessing,
  publishReelViaApi,
  reelDraftBody,
  uploadDraft,
  uploadReel,
  verifiedUser,
} from '../support/posts.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
});

const NOT_FOUND_POST = { code: 'NOT_FOUND', message: 'Publicação não encontrada' };

async function draftStatus(headers: Record<string, string>, body: object): Promise<number> {
  return (await t.http.post('/v1/posts/drafts').set(headers).send(body)).status;
}

/** Autor pessoal com uma conexão, uma pessoa desconhecida e um criador olhando. */
async function audience() {
  const author = await verifiedUser(t, { handle: 'autora' });
  const friend = await signedInUser(t.http, t.database.db);
  const stranger = await signedInUser(t.http, t.database.db);
  const creator = await signedInUser(t.http, t.database.db, { accountType: 'creator' });
  await connect(t.database.db, author.user, friend.user);
  return { author, friend, stranger, creator };
}

async function feedReels(headers: Record<string, string>) {
  const response = await t.http.get('/v1/feed?type=reel').set(headers).expect(200);
  return FeedPageSchema.parse(response.body);
}

async function profileReels(headers: Record<string, string>, handle: string) {
  const response = await t.http.get(`/v1/users/${handle}/posts?type=reel`).set(headers);
  return response.status === 200
    ? ProfilePostsPageSchema.parse(response.body).items
    : response.status;
}

describe('rascunho de reel (5.3, D10, MID-14)', () => {
  it('[MID-14] 90 s e 200 MB exatos → 201 com a URL do vídeo e a do poster, tipo e tamanho assinados', async () => {
    const { headers } = await verifiedUser(t);
    const draft = await createReelDraftViaApi(
      t,
      headers,
      reelDraftBody({ durationS: 90, sizeBytes: MAX_VIDEO_BYTES, mime: 'video/quicktime' }),
    );
    expect(draft.status).toBe('draft');
    expect(draft.uploads).toHaveLength(1);
    const [video] = draft.uploads;
    expect(video).toMatchObject({
      position: 0,
      method: 'PUT',
      headers: { 'Content-Type': 'video/quicktime', 'Content-Length': String(MAX_VIDEO_BYTES) },
    });
    expect(draft.poster).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '512' },
    });
    for (const target of [video!, draft.poster!]) {
      const url = new URL(target.url);
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';').sort()).toEqual([
        'content-length',
        'content-type',
        'host',
      ]);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    }
    expect(new URL(draft.poster!.url).pathname).toContain(`/incoming/`);
    expect(new URL(draft.poster!.url).pathname).toMatch(new RegExp(`${video!.mediaId}-poster$`));

    const [row] = await t.database.db
      .select()
      .from(postMedia)
      .where(eq(postMedia.id, video!.mediaId));
    expect(row).toMatchObject({
      kind: 'video',
      position: 0,
      mime: 'video/quicktime',
      sizeBytes: MAX_VIDEO_BYTES,
      durationS: 90,
      status: 'pending_upload',
      posterMime: 'image/jpeg',
      posterSizeBytes: 512,
    });
    const [post] = await t.database.db.select().from(posts).where(eq(posts.id, draft.postId));
    expect(post).toMatchObject({ type: 'reel', status: 'draft' });
  });

  it('[MID-14] [5.3 CA2] 91 s, 90,01 s ou 200 MB + 1 byte → 400, e nada é criado', async () => {
    const { headers } = await verifiedUser(t);
    for (const video of [
      { durationS: 91 },
      { durationS: 90.01 },
      { sizeBytes: MAX_VIDEO_BYTES + 1 },
    ]) {
      const response = await t.http
        .post('/v1/posts/drafts')
        .set(headers)
        .send(reelDraftBody(video))
        .expect(400);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
    }
    expect(await t.database.db.select().from(posts)).toHaveLength(0);
  });

  it('[MID-14] tipo de vídeo, poster ou campos fora do contrato → 400', async () => {
    const { headers } = await verifiedUser(t);
    const invalid = [
      reelDraftBody({ mime: 'video/webm' as never }),
      reelDraftBody({ mime: 'image/jpeg' as never }),
      reelDraftBody({ durationS: 0 }),
      reelDraftBody({}, { mime: 'video/mp4' as never }),
      reelDraftBody({}, { sizeBytes: MAX_POSTER_BYTES + 1 }),
      { type: 'reel', video: reelDraftBody().video },
      { ...reelDraftBody(), items: [{ mime: 'image/jpeg', sizeBytes: 1 }] },
      { type: 'reel', items: [{ mime: 'video/mp4', sizeBytes: 100 }] },
      { type: 'text', video: reelDraftBody().video, poster: reelDraftBody().poster },
    ];
    for (const body of invalid) {
      expect(await draftStatus(headers, body), JSON.stringify(body)).toBe(400);
    }
  });

  it('[X.3] e-mail não confirmado → 403 EMAIL_NOT_VERIFIED; o criador pode publicar reel', async () => {
    const unverified = await signedInUser(t.http, t.database.db);
    const response = await t.http
      .post('/v1/posts/drafts')
      .set(unverified.headers)
      .send(reelDraftBody())
      .expect(403);
    expect(ErrorResponseSchema.parse(response.body).code).toBe('EMAIL_NOT_VERIFIED');

    const creator = await verifiedUser(t, { accountType: 'creator' });
    await createReelDraftViaApi(t, creator.headers);
  });

  it('[R10] até 10 rascunhos de reel por hora por conta; o 11º → 429', async () => {
    const { headers } = await verifiedUser(t);
    for (let index = 0; index < 10; index++) {
      await createReelDraftViaApi(t, headers);
    }
    const response = await t.http
      .post('/v1/posts/drafts')
      .set(headers)
      .send(reelDraftBody())
      .expect(429);
    expect(ErrorResponseSchema.parse(response.body).code).toBe('RATE_LIMITED');
  });
});

describe('publicar reel (5.3)', () => {
  it('[5.3 CA1] vídeo e poster enviados → processing; a fila recebe post-video com o id do vídeo', async () => {
    const { headers } = await verifiedUser(t);
    const draft = await createReelDraftViaApi(t, headers);
    uploadReel(t, draft);
    const response = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(headers)
      .send({ caption: 'Ponte do rio Taquaral.' })
      .expect(200);
    const post = PostSchema.parse(response.body);
    expect(post).toMatchObject({
      type: 'reel',
      status: 'processing',
      caption: 'Ponte do rio Taquaral.',
      publishedAt: null,
      isOwn: true,
    });
    // Processando: nada é servido, nem o poster (MID-09).
    expect(post.media).toEqual([
      {
        id: draft.uploads[0]!.mediaId,
        kind: 'video',
        position: 0,
        status: 'processing',
        width: null,
        height: null,
        durationS: null,
        url: null,
        thumbUrl: null,
      },
    ]);
    expect(t.queue.sent.map((message) => MediaJobMessageSchema.parse(message))).toEqual([
      { type: 'post-video', mediaId: draft.uploads[0]!.mediaId },
    ]);
  });

  it('[MID-08] sem o poster → 409 com details.poster; sem o vídeo → details.positions [0]; repetir é idempotente', async () => {
    const { headers } = await verifiedUser(t);
    const noPoster = await createReelDraftViaApi(t, headers);
    uploadReel(t, noPoster, { poster: false });
    const missingPoster = await t.http
      .post(`/v1/posts/${noPoster.postId}/publish`)
      .set(headers)
      .send({})
      .expect(409);
    expect(ErrorResponseSchema.parse(missingPoster.body)).toMatchObject({
      code: 'MEDIA_NOT_UPLOADED',
      details: { positions: [], poster: true },
    });

    const noVideo = await createReelDraftViaApi(t, headers);
    const poster = noVideo.poster!;
    t.storage.upload(poster.url, Buffer.alloc(512, 1), 'image/jpeg');
    const missingVideo = await t.http
      .post(`/v1/posts/${noVideo.postId}/publish`)
      .set(headers)
      .send({})
      .expect(409);
    expect(ErrorResponseSchema.parse(missingVideo.body)).toMatchObject({
      details: { positions: [0], poster: false },
    });
    expect(t.queue.sent).toHaveLength(0);

    // Completa o envio: publica uma vez; o segundo publish devolve o mesmo estado.
    uploadDraft(t, noVideo);
    await t.http.post(`/v1/posts/${noVideo.postId}/publish`).set(headers).send({}).expect(200);
    await t.http.post(`/v1/posts/${noVideo.postId}/publish`).set(headers).send({}).expect(200);
    expect(t.queue.sent).toHaveLength(1);
  });

  it('[MID-03] vídeo maior que o declarado ou de outro tipo: o S3 recusa o PUT', async () => {
    const { headers } = await verifiedUser(t);
    const draft = await createReelDraftViaApi(t, headers);
    const [video] = draft.uploads;
    expect(t.storage.upload(video!.url, Buffer.alloc(4097), 'video/mp4').status).toBe(403);
    expect(t.storage.upload(video!.url, Buffer.alloc(4096), 'video/quicktime').status).toBe(403);
  });

  it('[MID-08] rascunho de reel de outra conta → 404 idêntico', async () => {
    const owner = await verifiedUser(t);
    const other = await verifiedUser(t);
    const draft = await createReelDraftViaApi(t, owner.headers);
    uploadReel(t, draft);
    const response = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(other.headers)
      .send({})
      .expect(404);
    expect(response.body).toEqual(NOT_FOUND_POST);
  });
});

describe('reel processando só para o autor (5.3 CA3, MID-09)', () => {
  it('[MID-09] conexão, desconhecido e criador não veem no feed, no perfil, no detalhe nem nos comentários; o autor vê o estado', async () => {
    const { author, friend, stranger, creator } = await audience();
    const reel = await publishReelViaApi(t, author.headers);

    const own = await t.http.get(`/v1/posts/${reel.id}`).set(author.headers).expect(200);
    expect(PostSchema.parse(own.body).status).toBe('processing');
    const ownTab = await profileReels(author.headers, 'autora');
    expect(Array.isArray(ownTab) && ownTab.map((post) => post.status)).toEqual(['processing']);
    expect((await feedReels(author.headers)).items).toEqual([]);

    expect((await feedReels(friend.headers)).items).toEqual([]);
    expect(await profileReels(friend.headers, 'autora')).toEqual([]);
    for (const viewer of [friend, stranger, creator]) {
      for (const path of [`/v1/posts/${reel.id}`, `/v1/posts/${reel.id}/comments`]) {
        const response = await t.http.get(path).set(viewer.headers).expect(404);
        expect(response.body).toEqual(NOT_FOUND_POST);
      }
      await t.http
        .put(`/v1/posts/${reel.id}/like`)
        .set(viewer.headers)
        .expect((res) => {
          expect([403, 404]).toContain(res.status);
        });
    }
    for (const viewer of [stranger, creator]) {
      expect(await profileReels(viewer.headers, 'autora')).toBe(404);
    }
    // Nenhuma URL assinada (vídeo nem poster) sai enquanto processa, nem para o autor.
    expect(JSON.stringify(own.body)).not.toMatch(/Signature|video\.mp4|poster/);
  });

  it('[5.3 CA1] [FEED-05] depois de pronto: aba Reels do feed e do perfil de quem pode ver, com duração, vídeo e poster', async () => {
    const { author, friend, stranger, creator } = await audience();
    const reel = await publishReelViaApi(t, author.headers, { caption: 'Neblina.' });
    t.clock.advance(60_000);
    await completeReelProcessing(t, reel.id, 42.48);

    for (const viewer of [author, friend]) {
      const feed = await feedReels(viewer.headers);
      expect(feed.items.map((item) => item.id)).toEqual([reel.id]);
      const [item] = feed.items;
      expect(item).toMatchObject({ type: 'reel', status: 'published', caption: 'Neblina.' });
      expect(item!.media).toHaveLength(1);
      const [media] = item!.media;
      expect(media).toMatchObject({
        kind: 'video',
        status: 'ready',
        width: 720,
        height: 1280,
        durationS: 42.48,
      });
      expect(new URL(media!.url!).pathname).toBe(`/media/${media!.id}/video.mp4`);
      expect(new URL(media!.thumbUrl!).pathname).toBe(`/media/${media!.id}/poster.jpg`);
      const tab = await profileReels(viewer.headers, 'autora');
      expect(Array.isArray(tab) && tab.map((post) => post.id)).toEqual([reel.id]);
    }
    // As outras abas não misturam reels.
    for (const type of ['photo', 'text']) {
      const response = await t.http.get(`/v1/feed?type=${type}`).set(friend.headers).expect(200);
      expect(FeedPageSchema.parse(response.body).items).toEqual([]);
    }
    // Reel de conta pessoal: só conexões (DoD da Fase 5).
    expect(await profileReels(stranger.headers, 'autora')).toBe(404);
    expect(await profileReels(creator.headers, 'autora')).toBe(404);
    await t.http.get(`/v1/posts/${reel.id}`).set(stranger.headers).expect(404);
    // Curtir e comentar como qualquer post publicado.
    await t.http.put(`/v1/posts/${reel.id}/like`).set(friend.headers).expect(200);
    await t.http
      .post(`/v1/posts/${reel.id}/comments`)
      .set(author.headers)
      .send({ body: 'Obrigada!' })
      .expect(201);
  });

  it('[5.3] reel de criador: qualquer conta vê no perfil; aparece no feed de quem segue', async () => {
    const creator = await verifiedUser(t, { accountType: 'creator', handle: 'trilhas' });
    const follower = await signedInUser(t.http, t.database.db);
    const other = await signedInUser(t.http, t.database.db);
    await follow(t.database.db, follower.user, creator.user);
    const reel = await publishReelViaApi(t, creator.headers);
    await completeReelProcessing(t, reel.id);

    expect((await feedReels(follower.headers)).items.map((item) => item.id)).toEqual([reel.id]);
    expect((await feedReels(other.headers)).items).toEqual([]);
    const tab = await profileReels(other.headers, 'trilhas');
    expect(Array.isArray(tab) && tab.map((post) => post.id)).toEqual([reel.id]);
  });

  it('[A-30] publicações do perfil somam os reels publicados (nunca os processando ou com falha)', async () => {
    const { author } = await audience();
    const ready = await publishReelViaApi(t, author.headers);
    await completeReelProcessing(t, ready.id);
    await publishReelViaApi(t, author.headers);
    const failed = await publishReelViaApi(t, author.headers);
    await failProcessing(t, failed.id);
    const me = MeSchema.parse((await t.http.get('/v1/me').set(author.headers).expect(200)).body);
    expect(me.counts.posts).toBe(1);
  });
});

describe('reel com falha (5.6, MID-10)', () => {
  it('[5.6 CA1] [MID-10] falhou: só o autor vê (perfil e detalhe); nunca um post fantasma no feed', async () => {
    const { author, friend, stranger } = await audience();
    const reel = await publishReelViaApi(t, author.headers);
    await failProcessing(t, reel.id);

    const own = PostSchema.parse(
      (await t.http.get(`/v1/posts/${reel.id}`).set(author.headers).expect(200)).body,
    );
    expect(own).toMatchObject({ status: 'failed', isOwn: true });
    expect(own.media[0]).toMatchObject({ status: 'failed', url: null, thumbUrl: null });
    const ownTab = await profileReels(author.headers, 'autora');
    expect(Array.isArray(ownTab) && ownTab.map((post) => post.status)).toEqual(['failed']);
    // Nem o motivo técnico da falha sai na resposta.
    expect(JSON.stringify(own)).not.toContain('MediaConvert');

    for (const viewer of [author, friend]) {
      expect((await feedReels(viewer.headers)).items).toEqual([]);
    }
    expect(await profileReels(friend.headers, 'autora')).toEqual([]);
    for (const viewer of [friend, stranger]) {
      await t.http.get(`/v1/posts/${reel.id}`).set(viewer.headers).expect(404);
    }
    // Com falha não se curte nem se comenta (o 404 de inexistente, até para o autor).
    await t.http
      .post(`/v1/posts/${reel.id}/comments`)
      .set(author.headers)
      .send({ body: 'oi' })
      .expect(404);
  });

  it('[5.6 CA1] "Excluir": DELETE apaga o reel com falha; "Tentar de novo" recria (novo rascunho) e publica', async () => {
    const { author, friend } = await audience();
    const failed = await publishReelViaApi(t, author.headers);
    await failProcessing(t, failed.id);

    await t.http.delete(`/v1/posts/${failed.id}`).set(author.headers).expect(204);
    await t.http.get(`/v1/posts/${failed.id}`).set(author.headers).expect(404);
    expect(await profileReels(author.headers, 'autora')).toEqual([]);
    // Outra conta não exclui (404 igual ao de inexistente).
    const other = await publishReelViaApi(t, author.headers);
    await failProcessing(t, other.id);
    await t.http.delete(`/v1/posts/${other.id}`).set(friend.headers).expect(404);

    // Nova tentativa = rascunho novo com o mesmo arquivo (o original com falha já saiu do S3).
    const retry = await publishReelViaApi(t, author.headers);
    expect(retry.id).not.toBe(failed.id);
    await completeReelProcessing(t, retry.id);
    expect((await feedReels(friend.headers)).items.map((item) => item.id)).toEqual([retry.id]);
  });

  it('[MID-10] um publish repetido de um reel com falha não o reprocessa (continua failed)', async () => {
    const { author } = await audience();
    const reel = await publishReelViaApi(t, author.headers);
    await failProcessing(t, reel.id);
    const response = await t.http
      .post(`/v1/posts/${reel.id}/publish`)
      .set(author.headers)
      .send({})
      .expect(200);
    expect(PostSchema.parse(response.body).status).toBe('failed');
    expect(t.queue.sent).toHaveLength(1);
  });
});

describe('reels do seed e da factory (sanidade dos ajudantes)', () => {
  it('a factory cria um reel pronto que a API serve com kind video e a duração', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const reel = await createPost(t.database.db, author, { type: 'reel' });
    const reader = await signedInUser(t.http, t.database.db);
    const response = await t.http.get(`/v1/posts/${reel.id}`).set(reader.headers).expect(200);
    const [media] = PostSchema.parse(response.body).media;
    expect(media).toMatchObject({ kind: 'video', durationS: 42, width: 720, height: 1280 });
  });

  it('a foto continua com kind image e durationS null', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const photo = await createPost(t.database.db, author, { type: 'photo' });
    const reader = await signedInUser(t.http, t.database.db);
    const response = await t.http.get(`/v1/posts/${photo.id}`).set(reader.headers).expect(200);
    const [media] = PostSchema.parse(response.body).media;
    expect(media).toMatchObject({ kind: 'image', durationS: null });
    const draft = DraftSchema.safeParse({ postId: photo.id, status: 'draft', uploads: [] });
    expect(draft.success && draft.data.poster).toBeUndefined();
  });
});
