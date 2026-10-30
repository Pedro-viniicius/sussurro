// E2E das URLs de mídia e do avatar (histórias 2.4 e 2.2 CA8; MID-13, PERM-16).
import { avatarUploads, eq, users } from '@sussurro/db';
import { connect, createPost, createUser } from '@sussurro/db/testing';
import {
  AvatarStatusSchema,
  AvatarUploadSchema,
  ErrorResponseSchema,
  MeSchema,
  PostSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testCloudFrontKeys, TEST_CLOUDFRONT_DOMAIN } from '../../src/testing/test-env.js';
import { signedInUser } from '../support/auth.js';
import { isValidCloudFrontUrl } from '../support/cloudfront.js';
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

const HOUR = 60 * 60 * 1000;

describe('URLs assinadas de leitura (PERM-16, A-19)', () => {
  it('[PERM-16] só quem vê o post recebe URL; a URL é do CloudFront, assinada e verificável', async () => {
    const author = await createUser(t.database.db);
    const friend = await signedInUser(t.http, t.database.db);
    const stranger = await signedInUser(t.http, t.database.db);
    await connect(t.database.db, author, friend.user);
    const post = await createPost(t.database.db, author, { type: 'photo', mediaCount: 1 });

    const denied = await t.http.get(`/v1/posts/${post.id}`).set(stranger.headers).expect(404);
    expect(JSON.stringify(denied.body)).not.toContain('Signature');

    const response = await t.http.get(`/v1/posts/${post.id}`).set(friend.headers).expect(200);
    const [media] = PostSchema.parse(response.body).media;
    const url = new URL(media!.url!);
    expect(url.host).toBe(TEST_CLOUDFRONT_DOMAIN);
    expect(url.pathname).toBe(`/media/${media!.id}/full.jpg`);
    expect(isValidCloudFrontUrl(url.href, testCloudFrontKeys().publicKey, t.clock.now())).toBe(
      true,
    );
  });

  it('[PERM-16] URL adulterada, sem assinatura ou vencida não vale (verificação com a chave pública)', async () => {
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const reader = await signedInUser(t.http, t.database.db);
    const [first, second] = [
      await createPost(t.database.db, creator, { type: 'photo' }),
      await createPost(t.database.db, creator, { type: 'photo' }),
    ];
    const urlOf = async (id: string) =>
      new URL(
        PostSchema.parse((await t.http.get(`/v1/posts/${id}`).set(reader.headers)).body).media[0]!
          .url!,
      );
    const valid = await urlOf(first.id);
    const other = await urlOf(second.id);
    const publicKey = testCloudFrontKeys().publicKey;
    const now = t.clock.now();

    // Outro objeto com a assinatura deste.
    const swapped = new URL(other.href);
    swapped.search = valid.search;
    // Validade estendida à mão.
    const extended = new URL(valid.href);
    extended.searchParams.set('Expires', String(Number(valid.searchParams.get('Expires')) + 3600));
    // Sem assinatura.
    const unsigned = new URL(`${valid.origin}${valid.pathname}`);

    for (const forged of [swapped, extended, unsigned]) {
      expect(isValidCloudFrontUrl(forged.href, publicKey, now)).toBe(false);
    }
    // Validade: entre 5 e 6 h (janela de 1 h para reaproveitar a URL), nunca mais que 6 h.
    const expiresMs = Number(valid.searchParams.get('Expires')) * 1000;
    expect(expiresMs - now.getTime()).toBeGreaterThan(5 * HOUR);
    expect(expiresMs - now.getTime()).toBeLessThanOrEqual(6 * HOUR);
    expect(isValidCloudFrontUrl(valid.href, publicKey, new Date(now.getTime() + 6 * HOUR))).toBe(
      false,
    );
  });

  it('a URL de um objeto é a mesma dentro da janela (cache do app e da assinatura)', async () => {
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const reader = await signedInUser(t.http, t.database.db);
    const post = await createPost(t.database.db, creator, { type: 'photo' });
    const read = async () =>
      PostSchema.parse((await t.http.get(`/v1/posts/${post.id}`).set(reader.headers)).body)
        .media[0]!.url;
    const first = await read();
    t.clock.advance(60_000);
    expect(await read()).toBe(first);
  });
});

describe('foto de perfil (2.4, MID-13)', () => {
  it('[MID-13] mesmos limites das fotos: tipo e tamanho', async () => {
    const { headers } = await signedInUser(t.http, t.database.db);
    for (const body of [
      { mime: 'image/heic', sizeBytes: 10 },
      { mime: 'image/svg+xml', sizeBytes: 10 },
      { mime: 'image/jpeg', sizeBytes: 15 * 1024 * 1024 + 1 },
      { mime: 'image/jpeg', sizeBytes: 0 },
    ]) {
      await t.http.post('/v1/me/avatar/upload-url').set(headers).send(body).expect(400);
    }
  });

  it('[MID-13] CA1 (2.4): upload → PUT /me/avatar (processing, uma mensagem) → pronto aparece no perfil', async () => {
    const { user, headers } = await signedInUser(t.http, t.database.db, { handle: 'helena' });
    const created = await t.http
      .post('/v1/me/avatar/upload-url')
      .set(headers)
      .send({ mime: 'image/png', sizeBytes: 2048 })
      .expect(201);
    const upload = AvatarUploadSchema.parse(created.body);
    expect(new URL(upload.url).pathname).toContain(`/incoming/${user.id}/${upload.uploadId}`);

    const notYet = await t.http
      .put('/v1/me/avatar')
      .set(headers)
      .send({ uploadId: upload.uploadId })
      .expect(409);
    expect(ErrorResponseSchema.parse(notYet.body).code).toBe('MEDIA_NOT_UPLOADED');

    expect(t.storage.upload(upload.url, Buffer.alloc(2048), 'image/png').status).toBe(200);
    for (let index = 0; index < 2; index++) {
      const response = await t.http
        .put('/v1/me/avatar')
        .set(headers)
        .send({ uploadId: upload.uploadId })
        .expect(200);
      expect(AvatarStatusSchema.parse(response.body)).toEqual({
        uploadId: upload.uploadId,
        status: 'processing',
        avatarUrl: null,
      });
    }
    expect(t.queue.sent).toEqual([{ type: 'avatar', uploadId: upload.uploadId }]);

    // O worker (testado no apps/worker) grava a foto processada e troca o avatar.
    const key = `media/${upload.uploadId}/avatar.jpg`;
    await t.database.db
      .update(avatarUploads)
      .set({ status: 'ready', storageKey: key })
      .where(eq(avatarUploads.id, upload.uploadId));
    await t.database.db.update(users).set({ avatarKey: key }).where(eq(users.id, user.id));

    const ready = await t.http
      .put('/v1/me/avatar')
      .set(headers)
      .send({ uploadId: upload.uploadId })
      .expect(200);
    const status = AvatarStatusSchema.parse(ready.body);
    expect(status.status).toBe('ready');
    expect(new URL(status.avatarUrl!).pathname).toBe(`/${key}`);
    const me = MeSchema.parse((await t.http.get('/v1/me').set(headers)).body);
    expect(new URL(me.avatarUrl!).pathname).toBe(`/${key}`);
    const post = await createPost(t.database.db, user);
    const view = PostSchema.parse((await t.http.get(`/v1/posts/${post.id}`).set(headers)).body);
    expect(new URL(view.author.avatarUrl!).pathname).toBe(`/${key}`);
  });

  it('upload de outra conta → 404; uploadId inválido → 400', async () => {
    const owner = await signedInUser(t.http, t.database.db);
    const other = await signedInUser(t.http, t.database.db);
    const upload = AvatarUploadSchema.parse(
      (
        await t.http
          .post('/v1/me/avatar/upload-url')
          .set(owner.headers)
          .send({ mime: 'image/jpeg', sizeBytes: 10 })
          .expect(201)
      ).body,
    );
    await t.http
      .put('/v1/me/avatar')
      .set(other.headers)
      .send({ uploadId: upload.uploadId })
      .expect(404);
    await t.http.put('/v1/me/avatar').set(other.headers).send({ uploadId: 'x' }).expect(400);
  });

  it('CA2 (2.4): "Remover foto" volta às iniciais e apaga o objeto', async () => {
    const { user, headers } = await signedInUser(t.http, t.database.db);
    const key = 'media/01a189e0-af57-7000-85fe-2054e618fea6/avatar.jpg';
    t.storage.put(key, Buffer.from('jpeg'), 'image/jpeg');
    await t.database.db.update(users).set({ avatarKey: key }).where(eq(users.id, user.id));
    expect(MeSchema.parse((await t.http.get('/v1/me').set(headers)).body).avatarUrl).not.toBeNull();

    await t.http.delete('/v1/me/avatar').set(headers).expect(204);
    expect(MeSchema.parse((await t.http.get('/v1/me').set(headers)).body).avatarUrl).toBeNull();
    expect(t.storage.deletedKeys).toEqual([key]);
    await t.http.delete('/v1/me/avatar').set(headers).expect(204);
  });
});
