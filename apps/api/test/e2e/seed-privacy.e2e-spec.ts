// História 3.8: perfil, posts, comentários e mídia revisados com as conexões reais do seed
// (`pnpm db:seed`): helena–caio.r e helena–marinac são conexões; caio.r e marinac, não. Quem não é
// conexão recebe o 404 de inexistente e nenhuma URL assinada (PERM-13, PERM-14, PERM-16).
import { and, eq, posts, users } from '@sussurro/db';
import { seedDatabase, TEST_PASSWORD_HASH } from '@sussurro/db/testing';
import {
  CommentsPageSchema,
  CreatorSearchResultSchema,
  FeedPageSchema,
  PostSchema,
  ProfilePostsPageSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { directSession } from '../support/auth.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;
const sessions = new Map<string, Record<string, string>>();
const MISSING_ID = '01a189e0-af57-7000-85fe-2054e618fea6';

async function session(handle: string) {
  const cached = sessions.get(handle);
  if (cached !== undefined) {
    return cached;
  }
  const [user] = await t.database.db.select().from(users).where(eq(users.handle, handle));
  const headers = await directSession(t.app, user!);
  sessions.set(handle, headers);
  return headers;
}

/** Um post publicado do seed, pelo @ do autor e pelo tipo. */
async function seedPost(handle: string, type: 'photo' | 'text' | 'reel') {
  const [row] = await t.database.db
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(and(eq(users.handle, handle), eq(posts.type, type)))
    .limit(1);
  return row!.id;
}

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.database.db, { passwordHash: TEST_PASSWORD_HASH, now: t.clock.now() });
});

afterAll(async () => {
  await t.close();
});

describe('3.8: posts e perfil pessoal só para conexões (seed)', () => {
  it('[PERM-13] [PERM-14] [PERM-16] conexão (helena → marinac) vê perfil, abas, post com URL assinada e comentários', async () => {
    const helena = await session('helena');
    await t.http.get('/v1/users/marinac').set(helena).expect(200);
    const tab = ProfilePostsPageSchema.parse(
      (await t.http.get('/v1/users/marinac/posts?type=photo').set(helena).expect(200)).body,
    );
    expect(tab.items.length).toBeGreaterThan(0);
    const photo = await seedPost('marinac', 'photo');
    const post = PostSchema.parse(
      (await t.http.get(`/v1/posts/${photo}`).set(helena).expect(200)).body,
    );
    expect(post.media.every((item) => item.url?.includes('Signature') === true)).toBe(true);
    CommentsPageSchema.parse(
      (await t.http.get(`/v1/posts/${photo}/comments`).set(helena).expect(200)).body,
    );
  });

  it('CA1 (3.8): não conexão (caio.r → marinac) e criador (cozinhadabia → helena): o 404 de inexistente em perfil, abas, post, comentários, curtir e comentar; nenhuma URL assinada', async () => {
    const cases: [viewer: string, owner: string][] = [
      ['caio.r', 'marinac'],
      ['marinac', 'caio.r'],
      ['cozinhadabia', 'helena'],
    ];
    for (const [viewer, owner] of cases) {
      const headers = await session(viewer);
      const photo = await seedPost(owner, owner === 'caio.r' ? 'text' : 'photo');
      const pairs: [
        method: 'get' | 'put' | 'post',
        path: string,
        missing: string,
        body?: object,
      ][] = [
        ['get', `/v1/users/${owner}`, '/v1/users/naoexiste'],
        ['get', `/v1/users/${owner}/posts?type=photo`, '/v1/users/naoexiste/posts?type=photo'],
        ['get', `/v1/users/${owner}/posts?type=text`, '/v1/users/naoexiste/posts?type=text'],
        ['get', `/v1/posts/${photo}`, `/v1/posts/${MISSING_ID}`],
        ['get', `/v1/posts/${photo}/comments`, `/v1/posts/${MISSING_ID}/comments`],
        ['put', `/v1/posts/${photo}/like`, `/v1/posts/${MISSING_ID}/like`],
        ['post', `/v1/posts/${photo}/comments`, `/v1/posts/${MISSING_ID}/comments`, { body: 'oi' }],
      ];
      for (const [method, path, missingPath, body] of pairs) {
        const response = await t.http[method](path)
          .set(headers)
          .send(body ?? {});
        const missing = await t.http[method](missingPath)
          .set(headers)
          .send(body ?? {});
        // O criador não curte (A-06): 403 igual para o post invisível e o inexistente.
        expect({ viewer, path, status: response.status, body: response.body as unknown }).toEqual({
          viewer,
          path,
          status: missing.status,
          body: missing.body as unknown,
        });
        expect([403, 404]).toContain(response.status);
        expect(JSON.stringify(response.body)).not.toContain('Signature');
        expect(JSON.stringify(response.body)).not.toContain('media/');
      }
    }
  });

  it('Fase 5: o reel de marinac (pessoal) aparece na aba Reels de helena (conexão) e nunca para caio.r', async () => {
    const reel = await seedPost('marinac', 'reel');
    const helena = await session('helena');
    const caio = await session('caio.r');
    const feed = FeedPageSchema.parse(
      (await t.http.get('/v1/feed?type=reel').set(helena).expect(200)).body,
    );
    expect(feed.items.map((item) => item.id)).toContain(reel);
    expect(feed.items.find((item) => item.id === reel)?.media[0]).toMatchObject({
      kind: 'video',
      durationS: 15,
    });
    const caioFeed = FeedPageSchema.parse(
      (await t.http.get('/v1/feed?type=reel').set(caio).expect(200)).body,
    );
    expect(caioFeed.items.map((item) => item.id)).not.toContain(reel);
    await t.http.get(`/v1/posts/${reel}`).set(caio).expect(404);
    await t.http.get('/v1/users/marinac/posts?type=reel').set(caio).expect(404);
  });

  it('[X.2] bloqueio do seed: @estudante não acha @trilhasdosul na busca e recebe 404 no perfil; outra pessoa acha', async () => {
    const estudante = await session('estudante');
    const helena = await session('helena');
    const search = async (headers: Record<string, string>) =>
      CreatorSearchResultSchema.parse(
        (await t.http.get('/v1/search/creators?q=tri').set(headers).expect(200)).body,
      ).items.map((item) => item.handle);
    expect(await search(estudante)).toEqual([]);
    expect(await search(helena)).toEqual(['trilhasdosul']);
    await t.http.get('/v1/users/trilhasdosul').set(estudante).expect(404);
    // E a busca do seed por "estu": os dois estúdios, nunca a conta pessoal @estudante (BUS-04).
    const estu = CreatorSearchResultSchema.parse(
      (await t.http.get('/v1/search/creators?q=estu').set(helena).expect(200)).body,
    );
    expect(estu.items.map((item) => item.handle)).toEqual(['estudioaurora', 'estudiovinil']);
  });
});
