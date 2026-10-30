// E2E das publicações (histórias 2.1, 2.2 e 2.9; testes.md §6.8 e §6.9).
import { eq, postMedia, posts, users } from '@sussurro/db';
import { connect, createPost, createUser } from '@sussurro/db/testing';
import {
  ErrorResponseSchema,
  MAX_IMAGE_BYTES,
  MediaJobMessageSchema,
  MeSchema,
  PostSchema,
  ProfilePostsPageSchema,
} from '@sussurro/shared';
import textCountFixtures from '@sussurro/shared/fixtures/text-count.json' with { type: 'json' };
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signedInUser } from '../support/auth.js';
import {
  completeProcessing,
  createDraftViaApi,
  createTextPostViaApi,
  jpegItems,
  publishPhotoViaApi,
  uploadDraft,
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

interface TextFixture {
  id: string;
  label: string;
  parts: { text: string; times?: number }[];
  count: number;
  valid: boolean;
}

const textFixtures = textCountFixtures.cases as TextFixture[];
const NOT_FOUND_POST = { code: 'NOT_FOUND', message: 'Publicação não encontrada' };

describe('POST /posts: texto (2.1)', () => {
  it.each(textFixtures.map((fixture) => [`${fixture.id} ${fixture.label}`, fixture] as const))(
    '[TXT-01] [TXT-02] %s: a API aceita ou recusa como as fixtures do app',
    async (_name, fixture) => {
      const { headers } = await verifiedUser(t);
      const text = fixture.parts.map((part) => part.text.repeat(part.times ?? 1)).join('');
      const response = await t.http.post('/v1/posts').set(headers).send({ type: 'text', text });
      if (fixture.valid) {
        expect(response.status).toBe(201);
        expect(PostSchema.parse(response.body)).toMatchObject({
          type: 'text',
          status: 'published',
          text: text.normalize('NFC').replace(/\r\n/g, '\n').trim(),
        });
      } else {
        expect(response.status).toBe(400);
        expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
      }
    },
  );

  it('[TXT-03] vazio, só espaços ou só invisíveis → 400 (o "Compartilhar" do app fica desabilitado)', async () => {
    const { headers } = await verifiedUser(t);
    for (const text of ['', '   ', '\n\n', '​​', '‍﻿']) {
      await t.http.post('/v1/posts').set(headers).send({ type: 'text', text }).expect(400);
    }
    expect(await t.database.db.select().from(posts)).toHaveLength(0);
  });

  it('CA1 (2.1): nasce published e aparece no perfil, na aba textos', async () => {
    const { user, headers } = await verifiedUser(t, { handle: 'helena' });
    const post = await createTextPostViaApi(t, headers, 'Café coado e livro usado');
    expect(post).toMatchObject({
      status: 'published',
      isOwn: true,
      likeCount: 0,
      commentCount: 0,
      likedByMe: false,
      media: [],
      caption: null,
      publishedAt: t.clock.now().toISOString(),
      author: { handle: 'helena', name: user.name, accountType: 'personal', avatarUrl: null },
    });
    const profile = await t.http.get('/v1/users/helena/posts?type=text').set(headers).expect(200);
    expect(ProfilePostsPageSchema.parse(profile.body).items.map((item) => item.id)).toEqual([
      post.id,
    ]);
  });

  it('criador também publica texto', async () => {
    const { headers } = await verifiedUser(t, { accountType: 'creator' });
    const post = await createTextPostViaApi(t, headers);
    expect(post.author.accountType).toBe('creator');
  });

  it('campo a mais ou tipo diferente de texto → 400', async () => {
    const { headers } = await verifiedUser(t);
    await t.http
      .post('/v1/posts')
      .set(headers)
      .send({ type: 'text', text: 'oi', status: 'draft' })
      .expect(400);
    await t.http.post('/v1/posts').set(headers).send({ type: 'photo', text: 'oi' }).expect(400);
  });
});

describe('bloqueio parcial do e-mail não confirmado (X.3)', () => {
  it('[X.3] criar texto, rascunho, publicar e comentar → 403 EMAIL_NOT_VERIFIED', async () => {
    const unverified = await signedInUser(t.http, t.database.db, { emailVerifiedAt: null });
    const draft = await createPost(t.database.db, unverified.user, {
      type: 'photo',
      status: 'draft',
    });
    const post = await createPost(t.database.db, unverified.user);

    const attempts = [
      t.http.post('/v1/posts').set(unverified.headers).send({ type: 'text', text: 'oi' }),
      t.http
        .post('/v1/posts/drafts')
        .set(unverified.headers)
        .send({ type: 'photo', items: jpegItems(1) }),
      t.http.post(`/v1/posts/${draft.id}/publish`).set(unverified.headers).send({}),
      t.http.post(`/v1/posts/${post.id}/comments`).set(unverified.headers).send({ body: 'oi' }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Confirme o e-mail para fazer isso',
      });
    }
    expect(await t.database.db.select().from(posts)).toHaveLength(2);
  });

  it('[X.3] ler, curtir, perfil e conta continuam liberados', async () => {
    const unverified = await signedInUser(t.http, t.database.db, { emailVerifiedAt: null });
    const post = await createPost(t.database.db, unverified.user);
    await t.http.get(`/v1/posts/${post.id}`).set(unverified.headers).expect(200);
    await t.http.put(`/v1/posts/${post.id}/like`).set(unverified.headers).expect(200);
    await t.http.get(`/v1/posts/${post.id}/comments`).set(unverified.headers).expect(200);
    await t.http.get('/v1/feed?type=text').set(unverified.headers).expect(200);
    const me = await t.http.get('/v1/me').set(unverified.headers).expect(200);
    expect(MeSchema.parse(me.body).emailVerified).toBe(false);
    await t.http.patch('/v1/me').set(unverified.headers).send({ name: 'Nova' }).expect(200);
    await t.http
      .post('/v1/me/avatar/upload-url')
      .set(unverified.headers)
      .send({ mime: 'image/png', sizeBytes: 10 })
      .expect(201);
  });

  it('[X.3] a confirmação vale na hora, sem novo login', async () => {
    const { user, headers } = await signedInUser(t.http, t.database.db, { emailVerifiedAt: null });
    await t.http.post('/v1/posts').set(headers).send({ type: 'text', text: 'oi' }).expect(403);
    await t.http.post('/v1/me/email/verification').set(headers).expect(202);
    const token = new URL(t.outbox.lastTo(user.email).link ?? '').searchParams.get('token');
    await t.http.post('/v1/auth/email/verify').send({ token }).expect(204);
    await t.http.post('/v1/posts').set(headers).send({ type: 'text', text: 'oi' }).expect(201);
  });
});

describe('POST /posts/drafts (2.2)', () => {
  it('[MID-01] 0 e 5 imagens → 400; 1 e 4 → 201 com uma URL por imagem', async () => {
    const { headers } = await verifiedUser(t);
    for (const count of [0, 5]) {
      await t.http
        .post('/v1/posts/drafts')
        .set(headers)
        .send({ type: 'photo', items: jpegItems(count) })
        .expect(400);
    }
    for (const count of [1, 4]) {
      const draft = await createDraftViaApi(t, headers, jpegItems(count));
      expect(draft.status).toBe('draft');
      expect(draft.uploads.map((upload) => upload.position)).toEqual(
        Array.from({ length: count }, (_, index) => index),
      );
    }
  });

  it('[MID-02] HEIC, GIF, PDF e vídeo em post de foto → 400; JPEG, PNG e WebP → 201', async () => {
    const { headers } = await verifiedUser(t);
    for (const mime of ['image/heic', 'image/gif', 'application/pdf', 'video/mp4']) {
      await t.http
        .post('/v1/posts/drafts')
        .set(headers)
        .send({ type: 'photo', items: [{ mime, sizeBytes: 100 }] })
        .expect(400);
    }
    const draft = await createDraftViaApi(t, headers, [
      { mime: 'image/jpeg', sizeBytes: 100 },
      { mime: 'image/png', sizeBytes: 100 },
      { mime: 'image/webp', sizeBytes: 100 },
    ]);
    expect(draft.uploads.map((upload) => upload.headers['Content-Type'])).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('[MID-03] 15 MB exatos → 201; 15 MB + 1 byte → 400; reel no formato de foto → 400', async () => {
    const { headers } = await verifiedUser(t);
    await createDraftViaApi(t, headers, [{ mime: 'image/jpeg', sizeBytes: MAX_IMAGE_BYTES }]);
    await t.http
      .post('/v1/posts/drafts')
      .set(headers)
      .send({ type: 'photo', items: [{ mime: 'image/jpeg', sizeBytes: MAX_IMAGE_BYTES + 1 }] })
      .expect(400);
    await t.http
      .post('/v1/posts/drafts')
      .set(headers)
      .send({ type: 'reel', items: [{ mime: 'video/mp4', sizeBytes: 100 }] })
      .expect(400);
  });

  it('[MID-03] a URL PUT assina Content-Type e Content-Length, vale 10 min e não leva checksum vazio', async () => {
    const { user, headers } = await verifiedUser(t);
    const draft = await createDraftViaApi(t, headers, [{ mime: 'image/png', sizeBytes: 4321 }]);
    const [upload] = draft.uploads;
    const url = new URL(upload!.url);
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';').sort()).toEqual([
      'content-length',
      'content-type',
      'host',
    ]);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261029T120000Z');
    // Sem o CRC32 "flexível" do SDK v3 (de corpo vazio), que quebraria o PUT do app.
    expect([...url.searchParams.keys()].filter((key) => /checksum/i.test(key))).toEqual([]);
    expect(url.pathname).toMatch(new RegExp(`/incoming/${user.id}/${upload!.mediaId}$`));
    expect(upload).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '4321' },
      expiresAt: new Date(t.clock.now().getTime() + 600_000).toISOString(),
    });
  });

  it('rate limit de upload: o 21º rascunho na hora → 429', async () => {
    const { headers } = await verifiedUser(t);
    for (let index = 0; index < 20; index++) {
      await createDraftViaApi(t, headers);
    }
    await t.http
      .post('/v1/posts/drafts')
      .set(headers)
      .send({ type: 'photo', items: jpegItems(1) })
      .expect(429);
  });
});

describe('POST /posts/:id/publish (2.2)', () => {
  it('CA1 (2.2): publish confere os objetos, passa a processing e manda uma mensagem por imagem', async () => {
    const { headers } = await verifiedUser(t);
    const draft = await createDraftViaApi(t, headers, jpegItems(3));
    uploadDraft(t, draft);
    const response = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(headers)
      .send({ caption: '  Domingo no Passaúna  ' })
      .expect(200);
    const post = PostSchema.parse(response.body);
    expect(post).toMatchObject({ status: 'processing', caption: 'Domingo no Passaúna' });
    expect(post.media.every((media) => media.status === 'processing' && media.url === null)).toBe(
      true,
    );
    expect(t.queue.sent.map((message) => MediaJobMessageSchema.parse(message))).toEqual(
      draft.uploads.map((upload) => ({ type: 'post-media', mediaId: upload.mediaId })),
    );
  });

  it('[MID-03] arquivo maior que o declarado é recusado no PUT e o publish dá MEDIA_NOT_UPLOADED', async () => {
    const { headers } = await verifiedUser(t);
    const draft = await createDraftViaApi(t, headers, [{ mime: 'image/jpeg', sizeBytes: 1000 }]);
    const [upload] = draft.uploads;
    expect(t.storage.upload(upload!.url, Buffer.alloc(2000), 'image/jpeg')).toEqual({
      status: 403,
      code: 'SignatureDoesNotMatch',
    });
    expect(t.storage.upload(upload!.url, Buffer.alloc(1000), 'text/html').status).toBe(403);
    const response = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(headers)
      .send({})
      .expect(409);
    expect(response.body).toEqual({
      code: 'MEDIA_NOT_UPLOADED',
      message: 'Há fotos que não foram enviadas',
      details: { positions: [0] },
    });
  });

  it('[MID-07] PUT depois dos 10 min é recusado e o publish responde MEDIA_NOT_UPLOADED', async () => {
    const { headers } = await verifiedUser(t);
    const draft = await createDraftViaApi(t, headers, jpegItems(2));
    const [first, second] = draft.uploads;
    expect(t.storage.upload(first!.url, Buffer.alloc(1024), 'image/jpeg').status).toBe(200);
    t.clock.advance(600_000 + 1_000);
    expect(t.storage.upload(second!.url, Buffer.alloc(1024), 'image/jpeg')).toEqual({
      status: 403,
      code: 'AccessDenied',
    });
    const response = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(headers)
      .send({})
      .expect(409);
    expect(ErrorResponseSchema.parse(response.body)).toMatchObject({
      code: 'MEDIA_NOT_UPLOADED',
      details: { positions: [1] },
    });
    expect(t.queue.sent).toEqual([]);
  });

  it('[MID-08] rascunho de outra pessoa → 404 igual ao de inexistente; sem upload → 409', async () => {
    const owner = await verifiedUser(t);
    const other = await verifiedUser(t);
    const draft = await createDraftViaApi(t, owner.headers);
    const foreign = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(other.headers)
      .send({})
      .expect(404);
    const missing = await t.http
      .post('/v1/posts/01a189e0-af57-7000-85fe-2054e618fea6/publish')
      .set(other.headers)
      .send({})
      .expect(404);
    expect(foreign.body).toEqual(NOT_FOUND_POST);
    expect(missing.body).toEqual(foreign.body);
    const notUploaded = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(owner.headers)
      .send({})
      .expect(409);
    expect(ErrorResponseSchema.parse(notUploaded.body).code).toBe('MEDIA_NOT_UPLOADED');
  });

  it('[MID-08] publish repetido é idempotente: mesmo estado e as mensagens saem uma vez só', async () => {
    const { headers } = await verifiedUser(t);
    const draft = await createDraftViaApi(t, headers, jpegItems(2));
    uploadDraft(t, draft);
    const [first, second] = await Promise.all([
      t.http.post(`/v1/posts/${draft.postId}/publish`).set(headers).send({ caption: 'a' }),
      t.http.post(`/v1/posts/${draft.postId}/publish`).set(headers).send({ caption: 'b' }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(headers)
      .send({ caption: 'c' })
      .expect(200);
    expect(PostSchema.parse(third.body).status).toBe('processing');
    expect(t.queue.sent).toHaveLength(2);

    await completeProcessing(t, draft.postId);
    const afterReady = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(headers)
      .send({})
      .expect(200);
    expect(PostSchema.parse(afterReady.body).status).toBe('published');
    expect(t.queue.sent).toHaveLength(2);
  });

  it('fila fora do ar → 503 e o post volta a rascunho; o próximo publish funciona', async () => {
    const { headers } = await verifiedUser(t);
    const draft = await createDraftViaApi(t, headers);
    uploadDraft(t, draft);
    t.queue.failNext = true;
    const failed = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(headers)
      .send({})
      .expect(503);
    expect(ErrorResponseSchema.parse(failed.body).code).toBe('SERVICE_UNAVAILABLE');
    const [row] = await t.database.db.select().from(posts);
    expect(row?.status).toBe('draft');
    expect((await t.database.db.select().from(postMedia))[0]?.status).toBe('pending_upload');
    await t.http.post(`/v1/posts/${draft.postId}/publish`).set(headers).send({}).expect(200);
    expect(t.queue.sent).toHaveLength(1);
  });

  it('[MID-09] em processing: o autor vê com o estado; a conexão recebe 404 e não vê no perfil', async () => {
    const author = await verifiedUser(t, { handle: 'marinac' });
    const friend = await verifiedUser(t);
    await connect(t.database.db, author.user, friend.user);
    const post = await publishPhotoViaApi(t, author.headers);

    const own = await t.http.get(`/v1/posts/${post.id}`).set(author.headers).expect(200);
    expect(PostSchema.parse(own.body)).toMatchObject({ status: 'processing', isOwn: true });
    const denied = await t.http.get(`/v1/posts/${post.id}`).set(friend.headers).expect(404);
    expect(denied.body).toEqual(NOT_FOUND_POST);

    const ownProfile = await t.http
      .get('/v1/users/marinac/posts?type=photo')
      .set(author.headers)
      .expect(200);
    expect(ProfilePostsPageSchema.parse(ownProfile.body).items).toHaveLength(1);
    const friendView = await t.http
      .get('/v1/users/marinac/posts?type=photo')
      .set(friend.headers)
      .expect(200);
    expect(ProfilePostsPageSchema.parse(friendView.body).items).toEqual([]);

    await completeProcessing(t, post.id);
    const published = await t.http.get(`/v1/posts/${post.id}`).set(friend.headers).expect(200);
    const view = PostSchema.parse(published.body);
    expect(view.status).toBe('published');
    expect(view.media[0]).toMatchObject({ status: 'ready', width: 1080, height: 1350 });
    expect(view.media[0]?.url).toContain('/full.jpg');
    expect(view.media[0]?.thumbUrl).toContain('/thumb.jpg');
  });
});

describe('GET /posts/:id (PERM-14)', () => {
  it('[PERM-14] post de pessoal: dono e conexão 200; não conexão, criador e inexistente 404 idênticos', async () => {
    const author = await verifiedUser(t);
    const friend = await verifiedUser(t);
    const stranger = await verifiedUser(t);
    const creator = await verifiedUser(t, { accountType: 'creator' });
    await connect(t.database.db, author.user, friend.user);
    const post = await createTextPostViaApi(t, author.headers);

    await t.http.get(`/v1/posts/${post.id}`).set(author.headers).expect(200);
    const friendView = await t.http.get(`/v1/posts/${post.id}`).set(friend.headers).expect(200);
    expect(PostSchema.parse(friendView.body).isOwn).toBe(false);

    const bodies = [];
    for (const path of [
      `/v1/posts/${post.id}`,
      '/v1/posts/01a189e0-af57-7000-85fe-2054e618fea6',
      '/v1/posts/nao-e-um-uuid',
    ]) {
      for (const viewer of [stranger, creator]) {
        const response = await t.http.get(path).set(viewer.headers).expect(404);
        bodies.push(response.body as unknown);
      }
    }
    for (const body of bodies) {
      expect(body).toEqual(NOT_FOUND_POST);
    }
  });

  it('[PERM-14] post de criador: qualquer conta autenticada vê (inclusive outro criador)', async () => {
    const creator = await verifiedUser(t, { accountType: 'creator' });
    const otherCreator = await verifiedUser(t, { accountType: 'creator' });
    const person = await verifiedUser(t);
    const post = await createTextPostViaApi(t, creator.headers);
    await t.http.get(`/v1/posts/${post.id}`).set(person.headers).expect(200);
    await t.http.get(`/v1/posts/${post.id}`).set(otherCreator.headers).expect(200);
  });

  it('[CONTA-02] post de conta excluída → 404 na hora', async () => {
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, creator);
    const reader = await verifiedUser(t);
    await t.http.get(`/v1/posts/${post.id}`).set(reader.headers).expect(200);
    await t.database.db
      .update(users)
      .set({ deletedAt: t.clock.now() })
      .where(eq(users.id, creator.id));
    const response = await t.http.get(`/v1/posts/${post.id}`).set(reader.headers).expect(404);
    expect(response.body).toEqual(NOT_FOUND_POST);
  });
});

describe('DELETE /posts/:id (2.9)', () => {
  it('[CNT-05] CA1 (2.9): o autor apaga; some do detalhe, do perfil e do contador na hora', async () => {
    const { headers } = await verifiedUser(t, { handle: 'helena' });
    const kept = await createTextPostViaApi(t, headers, 'fica');
    const removed = await createTextPostViaApi(t, headers, 'sai');
    expect(MeSchema.parse((await t.http.get('/v1/me').set(headers)).body).counts.posts).toBe(2);

    await t.http.delete(`/v1/posts/${removed.id}`).set(headers).expect(204);

    await t.http.get(`/v1/posts/${removed.id}`).set(headers).expect(404);
    const profile = await t.http.get('/v1/users/helena/posts?type=text').set(headers).expect(200);
    expect(ProfilePostsPageSchema.parse(profile.body).items.map((item) => item.id)).toEqual([
      kept.id,
    ]);
    expect(MeSchema.parse((await t.http.get('/v1/me').set(headers)).body).counts.posts).toBe(1);
    await t.http.delete(`/v1/posts/${removed.id}`).set(headers).expect(404);
  });

  it('CA2 (2.9): post de outra pessoa → 404, mesmo que ela veja o post', async () => {
    const author = await verifiedUser(t, { accountType: 'creator' });
    const reader = await verifiedUser(t);
    const post = await createTextPostViaApi(t, author.headers);
    const response = await t.http.delete(`/v1/posts/${post.id}`).set(reader.headers).expect(404);
    expect(response.body).toEqual(NOT_FOUND_POST);
    await t.http.get(`/v1/posts/${post.id}`).set(reader.headers).expect(200);
  });

  it('[CNT-05] rascunho, processing e failed não contam em publicações', async () => {
    const { user, headers } = await verifiedUser(t);
    await createPost(t.database.db, user, { type: 'photo', status: 'draft' });
    await createPost(t.database.db, user, { type: 'photo', status: 'processing' });
    await createPost(t.database.db, user, { type: 'photo', status: 'failed' });
    await createPost(t.database.db, user, { type: 'photo' });
    const me = await t.http.get('/v1/me').set(headers).expect(200);
    expect(MeSchema.parse(me.body).counts.posts).toBe(1);
  });
});
