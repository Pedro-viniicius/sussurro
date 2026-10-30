// E2E das listas próprias (história 3.6, ADR 0004; testes.md PERM-05 e PERM-08; X.2 CA4).
import { eq, users } from '@sussurro/db';
import { block, connect, createUser, follow } from '@sussurro/db/testing';
import {
  BlocksPageSchema,
  ConnectionsPageSchema,
  ErrorResponseSchema,
  FollowingPageSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { directUser } from '../support/auth.js';
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

const MINUTE = 60_000;
const at = (minutesAgo: number) => new Date(t.clock.now().getTime() - minutesAgo * MINUTE);

function person(options: Parameters<typeof createUser>[1] = {}) {
  return directUser(t.app, t.database.db, options);
}

async function connections(headers: Record<string, string>, query = '') {
  const response = await t.http.get(`/v1/me/connections${query}`).set(headers).expect(200);
  return ConnectionsPageSchema.parse(response.body);
}

async function following(headers: Record<string, string>, query = '') {
  const response = await t.http.get(`/v1/me/following${query}`).set(headers).expect(200);
  return FollowingPageSchema.parse(response.body);
}

describe('GET /me/connections e /me/following (3.6)', () => {
  it('3.6 CA1: só as listas de quem chama (os dois lados do par), mais recentes primeiro', async () => {
    const me = await person({ handle: 'helena' });
    const before = await createUser(t.database.db, { handle: 'caio.r', name: 'Caio Ribeiro' });
    const after = await createUser(t.database.db, { handle: 'marinac' });
    const stranger = await createUser(t.database.db, { handle: 'estranho' });
    await connect(t.database.db, me.user, before, { createdAt: at(10) });
    await connect(t.database.db, after, me.user, { createdAt: at(5) });
    await connect(t.database.db, before, stranger, { createdAt: at(1) });
    const creator = await createUser(t.database.db, {
      handle: 'cozinhadabia',
      accountType: 'creator',
    });
    const otherCreator = await createUser(t.database.db, {
      handle: 'trilhasdosul',
      accountType: 'creator',
    });
    await follow(t.database.db, me.user, creator, { createdAt: at(30) });
    await follow(t.database.db, stranger, otherCreator, { createdAt: at(2) });

    const list = await connections(me.headers);
    expect(list).toEqual({
      items: [
        { handle: 'marinac', name: after.name, avatarUrl: null, since: at(5).toISOString() },
        { handle: 'caio.r', name: 'Caio Ribeiro', avatarUrl: null, since: at(10).toISOString() },
      ],
      nextCursor: null,
    });
    expect((await following(me.headers)).items.map((item) => item.handle)).toEqual([
      'cozinhadabia',
    ]);
    // A lista de outra pessoa é só dela.
    const other = await directUser(t.app, t.database.db, { handle: 'outra' });
    expect(await connections(other.headers)).toEqual({ items: [], nextCursor: null });
  });

  it('paginação por cursor, sem repetir nem pular (mesmo milissegundo); cursor de outra conta ou lista → 400', async () => {
    const me = await person();
    const creators = [];
    for (let index = 0; index < 5; index++) {
      creators.push(await createUser(t.database.db, { accountType: 'creator' }));
    }
    // Três follows no mesmo instante: o desempate é o id.
    for (const [index, creator] of creators.entries()) {
      await follow(t.database.db, me.user, creator, { createdAt: at(index < 3 ? 1 : index) });
    }
    const first = await following(me.headers, '?limit=2');
    expect(first.items).toHaveLength(2);
    const second = await following(
      me.headers,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const third = await following(
      me.headers,
      `?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`,
    );
    expect(third.nextCursor).toBeNull();
    const all = [...first.items, ...second.items, ...third.items].map((item) => item.handle);
    expect(new Set(all)).toEqual(new Set(creators.map((creator) => creator.handle)));
    expect(all).toHaveLength(5);

    const other = await person();
    for (const path of [
      `/v1/me/following?cursor=${encodeURIComponent(first.nextCursor!)}`,
      `/v1/me/connections?cursor=${encodeURIComponent(first.nextCursor!)}`,
    ]) {
      const headers = path.includes('following') ? other.headers : me.headers;
      const response = await t.http.get(path).set(headers).expect(400);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
    }
  });

  it('[PERM-08] ?userId=, ?handle= ou outro parâmetro → 400; header forjado é ignorado', async () => {
    const me = await person();
    const victim = await createUser(t.database.db, { handle: 'vitima' });
    const friend = await createUser(t.database.db, { handle: 'amiga_da_vitima' });
    await connect(t.database.db, victim, friend);
    for (const path of ['/v1/me/connections', '/v1/me/following', '/v1/me/blocks']) {
      for (const query of [
        `?userId=${victim.id}`,
        '?handle=vitima',
        '?user=vitima',
        '?limit=5&id=1',
      ]) {
        const response = await t.http.get(`${path}${query}`).set(me.headers).expect(400);
        expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
      }
      const forged = await t.http
        .get(path)
        .set({ ...me.headers, 'X-User-Id': victim.id, 'X-Handle': 'vitima' })
        .expect(200);
      expect(JSON.stringify(forged.body)).not.toContain('amiga_da_vitima');
    }
  });

  it('[PERM-05] criador → 403 em conexões e seguidos; a lista de bloqueados vale para os dois tipos', async () => {
    const creator = await person({ accountType: 'creator' });
    for (const path of ['/v1/me/connections', '/v1/me/following']) {
      const response = await t.http.get(path).set(creator.headers).expect(403);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
    }
    await t.http.get('/v1/me/blocks').set(creator.headers).expect(200);
  });

  it('3.6 CA6: conexões, criadores e bloqueados com a conta excluída não aparecem', async () => {
    const me = await person();
    const friend = await createUser(t.database.db, { handle: 'amiga' });
    const gone = await createUser(t.database.db, { handle: 'sumiu' });
    const creator = await createUser(t.database.db, { accountType: 'creator', handle: 'criadora' });
    const goneCreator = await createUser(t.database.db, { accountType: 'creator' });
    const blocked = await createUser(t.database.db, { handle: 'bloqueada' });
    await connect(t.database.db, me.user, friend);
    await connect(t.database.db, me.user, gone);
    await follow(t.database.db, me.user, creator);
    await follow(t.database.db, me.user, goneCreator);
    await block(t.database.db, me.user, blocked);
    for (const id of [gone.id, goneCreator.id, blocked.id]) {
      await t.database.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));
    }
    expect((await connections(me.headers)).items.map((item) => item.handle)).toEqual(['amiga']);
    expect((await following(me.headers)).items.map((item) => item.handle)).toEqual(['criadora']);
    const blocks = BlocksPageSchema.parse(
      (await t.http.get('/v1/me/blocks').set(me.headers).expect(200)).body,
    );
    expect(blocks.items).toEqual([]);
  });
});
