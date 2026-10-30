// E2E de seguir, do perfil de criador e do feed com criadores seguidos (histórias 3.3, 3.4, 3.5 e
// 3.9; testes.md PERM-01 a 04, PERM-09, CNT-02, CNT-03, FEED-01 e FEED-11).
import { Controller, Post } from '@nestjs/common';
import { eq, follows, users } from '@sussurro/db';
import { createPost, createUser, follow, TEST_PASSWORD } from '@sussurro/db/testing';
import {
  ErrorResponseSchema,
  type FeedPage,
  FeedPageSchema,
  FollowStateSchema,
  MeSchema,
  PublicProfileSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Public } from '../../src/common/auth/decorators.js';
import { ResponseSchema } from '../../src/common/http/response-schema.js';
import { FOLLOWERS_CACHE_TTL_MS } from '../../src/modules/users/follower-counts.service.js';
import { directSession, directUser, signedInUser } from '../support/auth.js';
import { listRoutes } from '../support/routes.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;

/** Só de teste: grava um follow com seguidor criador (o banco precisa recusar, PERM-02). */
@Controller('teste-follow')
class CreatorFollowsController {
  @Public()
  @Post()
  @ResponseSchema(z.object({ ok: z.boolean() }))
  async insertCreatorFollow() {
    const [first] = await t.database.db.select().from(users).where(eq(users.handle, 'criador_a'));
    const [second] = await t.database.db.select().from(users).where(eq(users.handle, 'criador_b'));
    await t.database.db.insert(follows).values({ followerId: first!.id, creatorId: second!.id });
    return { ok: true };
  }
}

beforeAll(async () => {
  t = await createTestApp({ controllers: [CreatorFollowsController] });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
});

const MINUTE = 60_000;
const NOT_FOUND_PROFILE = { code: 'NOT_FOUND', message: 'Perfil não encontrado' };

function person(options: Parameters<typeof createUser>[1] = {}) {
  return directUser(t.app, t.database.db, options);
}

function creatorUser(handle: string) {
  return createUser(t.database.db, { handle, accountType: 'creator' });
}

async function followRows() {
  return t.database.db.select().from(follows);
}

async function profile(headers: Record<string, string>, handle: string) {
  const response = await t.http.get(`/v1/users/${handle}`).set(headers).expect(200);
  return PublicProfileSchema.parse(response.body);
}

/** Número de seguidores no perfil de um criador (CNT-02). */
async function followersOf(headers: Record<string, string>, handle: string) {
  const result = await profile(headers, handle);
  if (result.accountType !== 'creator') {
    throw new Error(`@${handle} não é criador`);
  }
  return result.counts.followers;
}

async function me(headers: Record<string, string>) {
  const response = await t.http.get('/v1/me').set(headers).expect(200);
  return MeSchema.parse(response.body);
}

async function feed(headers: Record<string, string>, query = 'type=text'): Promise<FeedPage> {
  const response = await t.http.get(`/v1/feed?${query}`).set(headers).expect(200);
  return FeedPageSchema.parse(response.body);
}

describe('PUT/DELETE /creators/:handle/follow (3.3)', () => {
  it('[PERM-04] seguir duas vezes = 1 follow; deixar de seguir sem seguir → 200 sem efeito', async () => {
    await creatorUser('cozinhadabia');
    const { headers } = await person();

    const unfollowed = await t.http
      .delete('/v1/creators/cozinhadabia/follow')
      .set(headers)
      .expect(200);
    expect(FollowStateSchema.parse(unfollowed.body)).toEqual({ following: false });
    for (let index = 0; index < 2; index++) {
      const response = await t.http
        .put('/v1/creators/CozinhaDaBia/follow')
        .set(headers)
        .expect(200);
      expect(response.body).toEqual({ following: true });
    }
    expect(await followRows()).toHaveLength(1);
    await t.http.delete('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
    await t.http.delete('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
    expect(await followRows()).toHaveLength(0);
  });

  it('[PERM-01] criador tentando seguir → 403 ACCOUNT_TYPE_NOT_ALLOWED e nenhuma linha', async () => {
    await creatorUser('cozinhadabia');
    const creator = await person({ accountType: 'creator' });
    for (const method of ['put', 'delete'] as const) {
      for (const handle of ['cozinhadabia', 'naoexiste']) {
        const response = await t.http[method](`/v1/creators/${handle}/follow`)
          .set(creator.headers)
          .expect(403);
        expect(ErrorResponseSchema.parse(response.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
      }
    }
    expect(await followRows()).toHaveLength(0);
  });

  it('[PERM-02] o banco recusa follow de criador pela FK composta; o filtro responde 403, nunca 500', async () => {
    await creatorUser('criador_a');
    await creatorUser('criador_b');
    const response = await t.http.post('/v1/teste-follow').send({}).expect(403);
    expect(ErrorResponseSchema.parse(response.body).code).toBe('FORBIDDEN');
    expect(await followRows()).toHaveLength(0);
  });

  it('[PERM-03] @ de conta pessoal → 404 idêntico (status, corpo) ao de @ inexistente, excluído ou inválido', async () => {
    await createUser(t.database.db, { handle: 'helena' });
    await createUser(t.database.db, {
      handle: 'criadorexcluido',
      accountType: 'creator',
      deletedAt: new Date(),
    });
    const { user, headers } = await person();
    for (const method of ['put', 'delete'] as const) {
      for (const handle of ['helena', 'naoexiste', 'criadorexcluido', 'Inválido!', user.handle]) {
        const response = await t.http[method](`/v1/creators/${encodeURIComponent(handle)}/follow`)
          .set(headers)
          .expect(404);
        expect(response.body).toEqual(NOT_FOUND_PROFILE);
      }
    }
    expect(await followRows()).toHaveLength(0);
  });

  it('3.3 CA5: o 11º follow/unfollow no minuto → 429 (seguir e deixar de seguir somam)', async () => {
    await creatorUser('cozinhadabia');
    const { headers } = await person();
    for (let index = 0; index < 5; index++) {
      await t.http.put('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
      await t.http.delete('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
    }
    const limited = await t.http.put('/v1/creators/cozinhadabia/follow').set(headers).expect(429);
    expect(ErrorResponseSchema.parse(limited.body).code).toBe('RATE_LIMITED');
    // @ inexistente também gasta o limite (não dá para sondar sem custo).
    await t.http.put('/v1/creators/naoexiste/follow').set(headers).expect(429);
    t.clock.advance(MINUTE);
    await t.http.put('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
  });
});

describe('perfil de criador (3.4, 3.5)', () => {
  it('3.4 CA1: publicações, seguidores, followedByMe; criador vê o próprio sem lista (PERM-09)', async () => {
    const creator = await createUser(t.database.db, {
      handle: 'cozinhadabia',
      name: 'Beatriz Lemos',
      accountType: 'creator',
      bio: 'Receitas de casa.',
    });
    await createPost(t.database.db, creator);
    await createPost(t.database.db, creator, { status: 'processing', type: 'photo' });
    const { headers } = await person();

    expect(await profile(headers, 'cozinhadabia')).toEqual({
      handle: 'cozinhadabia',
      name: 'Beatriz Lemos',
      bio: 'Receitas de casa.',
      avatarUrl: null,
      accountType: 'creator',
      counts: { posts: 1, followers: 0 },
      followedByMe: false,
    });
    await t.http.put('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
    expect(await profile(headers, 'cozinhadabia')).toMatchObject({ followedByMe: true });

    // O próprio criador (3.5): só o número, sem lista, e followedByMe sempre false.
    const own = await directUser(t.app, t.database.db, { accountType: 'creator' });
    expect(await profile(own.headers, 'cozinhadabia')).toMatchObject({ followedByMe: false });
    t.clock.advance(FOLLOWERS_CACHE_TTL_MS);
    const ownMe = await me(await directSession(t.app, creator));
    expect(ownMe).toMatchObject({ accountType: 'creator', counts: { posts: 1, followers: 1 } });
    expect(JSON.stringify(ownMe)).not.toMatch(/follower(s|Ids|List)?"\s*:\s*\[/);
    // Nenhuma rota devolve seguidores (PERM-09): nem /me/followers nem /users/:h/followers.
    for (const path of ['/v1/me/followers', '/v1/users/cozinhadabia/followers']) {
      await t.http.get(path).set(headers).expect(404);
    }
    expect(listRoutes(t.app).some((route) => route.path.includes('follower'))).toBe(false);
  });

  it('[CNT-02] o número de seguidores muda em até 60 s; o "criadores" de quem segue, na hora', async () => {
    await creatorUser('cozinhadabia');
    const { headers } = await person();
    expect((await profile(headers, 'cozinhadabia')).counts).toEqual({ posts: 0, followers: 0 });

    await t.http.put('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
    expect((await me(headers)).counts).toMatchObject({ creators: 1 });
    // Ainda no cache (o app atualiza o botão de forma otimista).
    expect(await followersOf(headers, 'cozinhadabia')).toBeLessThanOrEqual(1);
    t.clock.advance(FOLLOWERS_CACHE_TTL_MS);
    expect((await profile(headers, 'cozinhadabia')).counts).toEqual({ posts: 0, followers: 1 });

    await t.http.delete('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
    expect((await me(headers)).counts).toMatchObject({ creators: 0 });
    t.clock.advance(FOLLOWERS_CACHE_TTL_MS);
    expect(await followersOf(headers, 'cozinhadabia')).toBe(0);
  });

  it('[CNT-03] follows de contas excluídas não contam: seguidor excluído sai em até 60 s; criador excluído sai na hora', async () => {
    const creator = await creatorUser('cozinhadabia');
    const other = await creatorUser('trilhasdosul');
    const viewer = await person();
    const leaving = await signedInUser(t.http, t.database.db, { emailVerifiedAt: new Date() });
    await follow(t.database.db, viewer.user, creator);
    await follow(t.database.db, viewer.user, other);
    await follow(t.database.db, leaving.user, creator);
    expect(await followersOf(viewer.headers, 'cozinhadabia')).toBe(2);

    await t.http
      .delete('/v1/me')
      .set(leaving.headers)
      .send({ password: TEST_PASSWORD })
      .expect(204);
    t.clock.advance(FOLLOWERS_CACHE_TTL_MS);
    expect(await followersOf(viewer.headers, 'cozinhadabia')).toBe(1);

    await t.database.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, other.id));
    expect((await me(viewer.headers)).counts).toMatchObject({ creators: 1 });
  });
});

describe('feed com criadores seguidos (3.9)', () => {
  it('[FEED-01] seguir pela API faz os posts do criador das últimas 72 h aparecerem na hora', async () => {
    const creator = await creatorUser('cozinhadabia');
    const recent = await createPost(t.database.db, creator, {
      createdAt: new Date(t.clock.now().getTime() - 2 * 60 * MINUTE),
    });
    await createPost(t.database.db, creator, {
      createdAt: new Date(t.clock.now().getTime() - 73 * 60 * MINUTE),
    });
    const { headers } = await person();
    expect((await feed(headers)).items).toEqual([]);

    await t.http.put('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
    expect((await feed(headers)).items.map((item) => item.id)).toEqual([recent.id]);
  });

  it('[FEED-11] deixar de seguir faz os posts sumirem, inclusive na próxima página com o cursor antigo', async () => {
    const kept = await creatorUser('trilhasdosul');
    const dropped = await creatorUser('cozinhadabia');
    const { headers } = await person();
    // Posts intercalados dos dois criadores, do mais novo para o mais antigo.
    for (let index = 0; index < 6; index++) {
      const author = index % 2 === 0 ? kept : dropped;
      await createPost(t.database.db, author, {
        createdAt: new Date(t.clock.now().getTime() - (index + 1) * MINUTE),
      });
    }
    await t.http.put('/v1/creators/trilhasdosul/follow').set(headers).expect(200);
    await t.http.put('/v1/creators/cozinhadabia/follow').set(headers).expect(200);

    const first = await feed(headers, 'type=text&limit=2');
    expect(first.items.map((item) => item.author.handle)).toEqual(['trilhasdosul', 'cozinhadabia']);
    expect(first.nextCursor).not.toBeNull();

    await t.http.delete('/v1/creators/cozinhadabia/follow').set(headers).expect(200);
    const next = await feed(
      headers,
      `type=text&limit=10&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(next.items.map((item) => item.author.handle)).toEqual(['trilhasdosul', 'trilhasdosul']);
    const fresh = await feed(headers);
    expect(fresh.items.every((item) => item.author.handle === 'trilhasdosul')).toBe(true);
  });
});
