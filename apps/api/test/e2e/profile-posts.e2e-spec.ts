// E2E das abas do perfil e dos números do perfil (história 2.6; PERM-13, CNT-01, CNT-05, A-11).
import { eq, users } from '@sussurro/db';
import { connect, createPost, createUser, follow } from '@sussurro/db/testing';
import { MeSchema, ProfilePostsPageSchema, PublicProfileSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signedInUser } from '../support/auth.js';
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

const PROFILE_NOT_FOUND = { code: 'NOT_FOUND', message: 'Perfil não encontrado' };
const MINUTE = 60_000;

function ago(ms: number): Date {
  return new Date(t.clock.now().getTime() - ms);
}

describe('perfil pessoal: quem vê (PERM-13, 2.6 CA2)', () => {
  it('[PERM-13] dono e conexão 200; não conexão, criador, inexistente e excluída 404 idênticos', async () => {
    const owner = await signedInUser(t.http, t.database.db, { handle: 'helena' });
    const friend = await signedInUser(t.http, t.database.db);
    const stranger = await signedInUser(t.http, t.database.db);
    const creator = await signedInUser(t.http, t.database.db, { accountType: 'creator' });
    await connect(t.database.db, owner.user, friend.user);
    await createUser(t.database.db, { handle: 'excluida', deletedAt: t.clock.now() });
    await createPost(t.database.db, owner.user, { createdAt: ago(MINUTE) });

    for (const viewer of [owner, friend]) {
      const profile = await t.http.get('/v1/users/helena').set(viewer.headers).expect(200);
      expect(PublicProfileSchema.parse(profile.body).handle).toBe('helena');
      const tab = await t.http.get('/v1/users/helena/posts?type=text').set(viewer.headers);
      expect(tab.status).toBe(200);
      expect(ProfilePostsPageSchema.parse(tab.body).items).toHaveLength(1);
    }

    const denied: unknown[] = [];
    for (const viewer of [stranger, creator]) {
      for (const handle of ['helena', 'naoexiste', 'excluida']) {
        for (const path of [`/v1/users/${handle}`, `/v1/users/${handle}/posts?type=text`]) {
          const response = await t.http.get(path).set(viewer.headers).expect(404);
          denied.push(response.body);
        }
      }
    }
    expect(new Set(denied.map((body) => JSON.stringify(body)))).toEqual(
      new Set([JSON.stringify(PROFILE_NOT_FOUND)]),
    );
  });

  it('CA1 (2.6): perfil de criador é visível a qualquer conta, com paginação estável', async () => {
    const creator = await createUser(t.database.db, {
      handle: 'cozinhadabia',
      accountType: 'creator',
    });
    const created = [];
    for (let index = 0; index < 5; index++) {
      created.push(
        await createPost(t.database.db, creator, {
          type: 'photo',
          createdAt: ago((index + 1) * MINUTE),
        }),
      );
    }
    // Fora da janela do feed continua no perfil (não há janela no perfil).
    const old = await createPost(t.database.db, creator, {
      type: 'photo',
      createdAt: ago(100 * 60 * MINUTE),
    });
    const otherCreator = await signedInUser(t.http, t.database.db, { accountType: 'creator' });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await t.http
        .get(`/v1/users/cozinhadabia/posts?type=photo&limit=2${query}`)
        .set(otherCreator.headers)
        .expect(200);
      const page = ProfilePostsPageSchema.parse(response.body);
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(ids).toEqual([...created, old].map((post) => post.id));
    const textTab = await t.http
      .get('/v1/users/cozinhadabia/posts?type=text')
      .set(otherCreator.headers)
      .expect(200);
    expect(ProfilePostsPageSchema.parse(textTab.body)).toEqual({ items: [], nextCursor: null });
  });

  it('[MID-09] CA3 (2.6): o dono vê posts em processing e failed; os outros, não', async () => {
    const owner = await signedInUser(t.http, t.database.db, { handle: 'marinac' });
    const friend = await signedInUser(t.http, t.database.db);
    await connect(t.database.db, owner.user, friend.user);
    await createPost(t.database.db, owner.user, { type: 'photo', status: 'processing' });
    await createPost(t.database.db, owner.user, { type: 'photo', status: 'failed' });
    await createPost(t.database.db, owner.user, { type: 'photo', status: 'draft' });
    const published = await createPost(t.database.db, owner.user, {
      type: 'photo',
      createdAt: ago(MINUTE),
    });
    const own = await t.http.get('/v1/users/marinac/posts?type=photo').set(owner.headers);
    expect(
      ProfilePostsPageSchema.parse(own.body)
        .items.map((item) => item.status)
        .sort(),
    ).toEqual(['failed', 'processing', 'published']);
    const theirs = await t.http.get('/v1/users/marinac/posts?type=photo').set(friend.headers);
    expect(ProfilePostsPageSchema.parse(theirs.body).items.map((item) => item.id)).toEqual([
      published.id,
    ]);
  });

  it('CA4 (2.6): type inválido, cursor adulterado ou de outro perfil → 400', async () => {
    const owner = await signedInUser(t.http, t.database.db, { handle: 'helena' });
    const other = await createUser(t.database.db, {
      handle: 'trilhasdosul',
      accountType: 'creator',
    });
    for (let index = 0; index < 3; index++) {
      await createPost(t.database.db, owner.user, { createdAt: ago((index + 1) * MINUTE) });
      await createPost(t.database.db, other, { createdAt: ago((index + 1) * MINUTE) });
    }
    for (const query of ['', 'type=video', 'type=text&limit=0', 'type=text&cursor=x.y']) {
      await t.http.get(`/v1/users/helena/posts?${query}`).set(owner.headers).expect(400);
    }
    const first = await t.http
      .get('/v1/users/helena/posts?type=text&limit=1')
      .set(owner.headers)
      .expect(200);
    const cursor = encodeURIComponent(ProfilePostsPageSchema.parse(first.body).nextCursor ?? '');
    await t.http
      .get(`/v1/users/trilhasdosul/posts?type=text&cursor=${cursor}`)
      .set(owner.headers)
      .expect(400);
    await t.http
      .get(`/v1/users/helena/posts?type=photo&cursor=${cursor}`)
      .set(owner.headers)
      .expect(400);
  });
});

describe('números do perfil (CNT-01, CNT-05, A-11)', () => {
  it('[CNT-01] pessoal: publicações de todos os tipos, conexões e criadores ativos', async () => {
    const me = await signedInUser(t.http, t.database.db, { handle: 'helena' });
    const friend = await createUser(t.database.db);
    const goneFriend = await createUser(t.database.db);
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const goneCreator = await createUser(t.database.db, { accountType: 'creator' });
    await connect(t.database.db, me.user, friend);
    await connect(t.database.db, me.user, goneFriend);
    await follow(t.database.db, me.user, creator);
    await follow(t.database.db, me.user, goneCreator);
    await createPost(t.database.db, me.user);
    await createPost(t.database.db, me.user, { type: 'photo' });
    await createPost(t.database.db, me.user, { type: 'photo', status: 'processing' });
    await createPost(t.database.db, me.user, { deletedAt: t.clock.now() });
    for (const gone of [goneFriend, goneCreator]) {
      await t.database.db
        .update(users)
        .set({ deletedAt: t.clock.now() })
        .where(eq(users.id, gone.id));
    }
    const response = await t.http.get('/v1/me').set(me.headers).expect(200);
    expect(MeSchema.parse(response.body).counts).toEqual({ posts: 2, connections: 1, creators: 1 });
  });

  it('[CNT-01] criador: publicações e seguidores ativos, visto por qualquer conta', async () => {
    const creator = await createUser(t.database.db, {
      handle: 'cozinhadabia',
      accountType: 'creator',
    });
    const fan = await signedInUser(t.http, t.database.db);
    const goneFan = await createUser(t.database.db, { deletedAt: t.clock.now() });
    await follow(t.database.db, fan.user, creator);
    await follow(t.database.db, goneFan, creator);
    await createPost(t.database.db, creator, { type: 'photo' });
    const response = await t.http.get('/v1/users/cozinhadabia').set(fan.headers).expect(200);
    expect(PublicProfileSchema.parse(response.body).counts).toEqual({ posts: 1, followers: 1 });
  });
});
