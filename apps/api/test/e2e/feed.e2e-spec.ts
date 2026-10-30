// E2E do feed cronológico (história 2.5, ADR 0005, testes.md §6.4).
import { and, connections, eq, posts, users } from '@sussurro/db';
import { connect, createPost, createUser, follow } from '@sussurro/db/testing';
import { ErrorResponseSchema, type FeedPage, FeedPageSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CursorCodec } from '../../src/common/http/cursor.js';
import { bearer, loginViaApi, signedInUser } from '../support/auth.js';
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

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function ago(ms: number): Date {
  return new Date(t.clock.now().getTime() - ms);
}

async function getFeed(
  headers: Record<string, string>,
  query: string,
  app: TestApp = t,
): Promise<FeedPage> {
  const response = await app.http.get(`/v1/feed?${query}`).set(headers).expect(200);
  return FeedPageSchema.parse(response.body);
}

/** Todas as páginas, seguindo o cursor. */
async function allPages(headers: Record<string, string>, query: string): Promise<FeedPage[]> {
  const pages: FeedPage[] = [];
  let cursor: string | null = null;
  do {
    const page = await getFeed(
      headers,
      cursor === null ? query : `${query}&cursor=${encodeURIComponent(cursor)}`,
    );
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < 20);
  return pages;
}

/** Leitor pessoal com sessão e `n` posts de texto de um autor que ele vê (criador seguido). */
async function readerWithPosts(count: number) {
  const reader = await signedInUser(t.http, t.database.db);
  const creator = await createUser(t.database.db, { accountType: 'creator' });
  await follow(t.database.db, reader.user, creator);
  const created = [];
  for (let index = 0; index < count; index++) {
    created.push(
      await createPost(t.database.db, creator, { createdAt: ago((index + 1) * MINUTE) }),
    );
  }
  return { reader, creator, created };
}

describe('GET /feed: quem aparece (FEED-01, D9)', () => {
  it('[FEED-01] conexões dos dois lados do par, criadores seguidos e os próprios posts; mais ninguém', async () => {
    // Uma conexão com o leitor como user_a e outra como user_b (par ordenado).
    const before = await createUser(t.database.db, { handle: 'antes' });
    const reader = await signedInUser(t.http, t.database.db, { handle: 'leitor' });
    const after = await createUser(t.database.db, { handle: 'depois' });
    await connect(t.database.db, reader.user, before);
    await connect(t.database.db, reader.user, after);
    // uuidv7 cresce com o tempo: o leitor fica como user_b num par e como user_a no outro.
    const pairs = await t.database.db.select().from(connections);
    expect(pairs.map((pair) => (pair.userAId === reader.user.id ? 'a' : 'b')).sort()).toEqual([
      'a',
      'b',
    ]);

    const followed = await createUser(t.database.db, { handle: 'seguido', accountType: 'creator' });
    const notFollowed = await createUser(t.database.db, {
      handle: 'naoseguido',
      accountType: 'creator',
    });
    const stranger = await createUser(t.database.db, { handle: 'estranho' });
    await follow(t.database.db, reader.user, followed);
    for (const author of [before, after, followed, notFollowed, stranger, reader.user]) {
      await createPost(t.database.db, author, { createdAt: ago(HOUR) });
    }

    const page = await getFeed(reader.headers, 'type=text');
    expect(page.items.map((item) => item.author.handle).sort()).toEqual(
      ['antes', 'depois', 'leitor', 'seguido'].sort(),
    );
    expect(page.items.find((item) => item.author.handle === 'leitor')?.isOwn).toBe(true);
  });

  it('[FEED-14] sem conexões nem criadores: lista vazia, caughtUp e sem cursor', async () => {
    const reader = await signedInUser(t.http, t.database.db);
    expect(await getFeed(reader.headers, 'type=photo')).toEqual({
      items: [],
      nextCursor: null,
      caughtUp: true,
      windowHours: 72,
    });
  });

  it('[FEED-13] criador recebe 403 ACCOUNT_TYPE_NOT_ALLOWED', async () => {
    const creator = await signedInUser(t.http, t.database.db, { accountType: 'creator' });
    const response = await t.http.get('/v1/feed?type=photo').set(creator.headers).expect(403);
    expect(ErrorResponseSchema.parse(response.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
  });
});

describe('GET /feed: ordem, janela e abas', () => {
  it('[FEED-02] published_at desc com desempate por id desc, estável entre chamadas', async () => {
    const { reader, creator } = await readerWithPosts(0);
    const same = ago(10 * MINUTE);
    const tied = [];
    for (let index = 0; index < 3; index++) {
      tied.push(await createPost(t.database.db, creator, { createdAt: same }));
    }
    const newer = await createPost(t.database.db, creator, { createdAt: ago(MINUTE) });
    // Foto criada há 2 h e publicada agora entra pelo published_at.
    const photo = await createPost(t.database.db, creator, {
      type: 'photo',
      createdAt: ago(2 * HOUR),
      publishedAt: t.clock.now(),
    });

    const first = await getFeed(reader.headers, 'type=text');
    const expected = [
      newer.id,
      ...tied
        .map((post) => post.id)
        .sort()
        .reverse(),
    ];
    expect(first.items.map((item) => item.id)).toEqual(expected);
    expect((await getFeed(reader.headers, 'type=text')).items.map((item) => item.id)).toEqual(
      expected,
    );
    const photos = await getFeed(reader.headers, 'type=photo');
    expect(photos.items.map((item) => item.id)).toEqual([photo.id]);
  });

  it('[FEED-03] janela de 72 h: 71h59m59s e 72h00m00s entram; 72h00m01s não', async () => {
    const { reader, creator } = await readerWithPosts(0);
    const inside = await createPost(t.database.db, creator, { createdAt: ago(72 * HOUR - SECOND) });
    const edge = await createPost(t.database.db, creator, { createdAt: ago(72 * HOUR) });
    await createPost(t.database.db, creator, { createdAt: ago(72 * HOUR + SECOND) });
    const page = await getFeed(reader.headers, 'type=text');
    expect(page.items.map((item) => item.id)).toEqual([inside.id, edge.id]);
    expect(page.windowHours).toBe(72);
  });

  it('[FEED-03b] [FEED-04] com FEED_WINDOW_HOURS=1 o corte vira 1 h e windowHours = 1', async () => {
    const oneHour = await createTestApp({ env: { FEED_WINDOW_HOURS: '1' } });
    try {
      const reader = await signedInUser(oneHour.http, oneHour.database.db);
      const creator = await createUser(oneHour.database.db, { accountType: 'creator' });
      await follow(oneHour.database.db, reader.user, creator);
      const now = oneHour.clock.now().getTime();
      const inside = await createPost(oneHour.database.db, creator, {
        createdAt: new Date(now - 59 * MINUTE),
      });
      await createPost(oneHour.database.db, creator, { createdAt: new Date(now - HOUR - SECOND) });
      const page = await getFeed(reader.headers, 'type=text', oneHour);
      expect(page.items.map((item) => item.id)).toEqual([inside.id]);
      expect(page.windowHours).toBe(1);
    } finally {
      await oneHour.close();
    }
  });

  it('[FEED-05] type filtra (reel só com reels, Fase 5); ausente ou inválido → 400', async () => {
    const { reader, creator } = await readerWithPosts(1);
    await createPost(t.database.db, creator, { type: 'photo', createdAt: ago(MINUTE) });
    expect((await getFeed(reader.headers, 'type=text')).items).toHaveLength(1);
    expect((await getFeed(reader.headers, 'type=photo')).items).toHaveLength(1);
    expect(await getFeed(reader.headers, 'type=reel')).toMatchObject({
      items: [],
      caughtUp: true,
    });
    // Fase 5: um reel publicado entra só na aba Reels, com kind video e a duração.
    const reel = await createPost(t.database.db, creator, { type: 'reel', createdAt: ago(MINUTE) });
    const reels = await getFeed(reader.headers, 'type=reel');
    expect(reels.items.map((item) => item.id)).toEqual([reel.id]);
    expect(reels.items[0]?.media[0]).toMatchObject({ kind: 'video', durationS: 42 });
    expect((await getFeed(reader.headers, 'type=photo')).items).toHaveLength(1);
    for (const query of ['', 'type=video', 'type=']) {
      const response = await t.http.get(`/v1/feed?${query}`).set(reader.headers).expect(400);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
    }
  });

  it('[FEED-10] apagados, rascunhos, processando e com falha nunca aparecem', async () => {
    const { reader, creator, created } = await readerWithPosts(1);
    await createPost(t.database.db, creator, { createdAt: ago(MINUTE), deletedAt: ago(1) });
    for (const status of ['draft', 'processing', 'failed'] as const) {
      await createPost(t.database.db, creator, { type: 'photo', status, createdAt: ago(MINUTE) });
    }
    await createPost(t.database.db, reader.user, { type: 'photo', status: 'processing' });
    expect((await getFeed(reader.headers, 'type=text')).items.map((item) => item.id)).toEqual([
      created[0]!.id,
    ]);
    expect((await getFeed(reader.headers, 'type=photo')).items).toEqual([]);
  });
});

describe('GET /feed: paginação (FEED-06 a FEED-09)', () => {
  it('[FEED-06] 45 posts com limit 20 → 20, 20 e 5, sem duplicar nem pular; a última com caughtUp', async () => {
    const { reader, created } = await readerWithPosts(45);
    const pages = await allPages(reader.headers, 'type=text&limit=20');
    expect(pages.map((page) => page.items.length)).toEqual([20, 20, 5]);
    expect(pages.map((page) => page.caughtUp)).toEqual([false, false, true]);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    const ids = pages.flatMap((page) => page.items.map((item) => item.id));
    expect(ids).toEqual(created.map((post) => post.id));
  });

  it.each([
    [0, [0]],
    [20, [20]],
    [21, [20, 1]],
    [40, [20, 20]],
  ])('[FEED-06] borda: %i posts → páginas %j', async (count, sizes) => {
    const { reader, created } = await readerWithPosts(count);
    const pages = await allPages(reader.headers, 'type=text&limit=20');
    expect(pages.map((page) => page.items.length)).toEqual(sizes);
    expect(pages.at(-1)?.caughtUp).toBe(true);
    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(
      created.map((post) => post.id),
    );
  });

  it('[FEED-07] (a) post novo entre as páginas não entra na 2ª; (b) post apagado da 2ª não abre lacuna', async () => {
    const { reader, creator, created } = await readerWithPosts(6);
    const first = await getFeed(reader.headers, 'type=text&limit=3');
    expect(first.items.map((item) => item.id)).toEqual(created.slice(0, 3).map((post) => post.id));

    await createPost(t.database.db, creator, { createdAt: t.clock.now() });
    await t.database.db
      .update(posts)
      .set({ deletedAt: t.clock.now() })
      .where(eq(posts.id, created[4]!.id));

    const second = await getFeed(
      reader.headers,
      `type=text&limit=3&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    expect(second.items.map((item) => item.id)).toEqual([created[3]!.id, created[5]!.id]);
    expect(second.caughtUp).toBe(true);
  });

  it('[FEED-07] (c) com o since no cursor, o post que passa de 72 h durante a rolagem continua aparecendo', async () => {
    const { reader, creator } = await readerWithPosts(0);
    const recent = await createPost(t.database.db, creator, { createdAt: ago(HOUR) });
    const old = await createPost(t.database.db, creator, { createdAt: ago(71 * HOUR) });
    const first = await getFeed(reader.headers, 'type=text&limit=1');
    expect(first.items.map((item) => item.id)).toEqual([recent.id]);

    // 70 min depois, o post de 71 h tem 72h10m (fora da janela de uma primeira página nova).
    t.clock.advance(70 * MINUTE);
    const session = await loginViaApi(t.http, reader.user.email);
    const headers = bearer(session.tokens.accessToken);
    const second = await getFeed(
      headers,
      `type=text&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    expect(second.items.map((item) => item.id)).toEqual([old.id]);
    expect((await getFeed(headers, 'type=text')).items.map((item) => item.id)).toEqual([recent.id]);
  });

  it('[FEED-08] cursor inválido, adulterado ou de outra aba → 400', async () => {
    const { reader } = await readerWithPosts(3);
    const first = await getFeed(reader.headers, 'type=text&limit=1');
    const cursor = first.nextCursor ?? '';
    const [body, signature] = cursor.split('.');
    const decoded = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const tampered = `${Buffer.from(JSON.stringify({ ...decoded, s: 0 })).toString('base64url')}.${signature!}`;
    const cases = [
      'nao-e-base64!!',
      'abc.def',
      tampered,
      `${body!}.${signature!.slice(1)}A`,
      cursor.repeat(2),
    ];
    for (const value of cases) {
      const response = await t.http
        .get(`/v1/feed?type=text&cursor=${encodeURIComponent(value)}`)
        .set(reader.headers)
        .expect(400);
      expect(response.body).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Cursor inválido',
        details: [{ path: 'cursor', message: 'Cursor inválido.' }],
      });
    }
    await t.http
      .get(`/v1/feed?type=photo&cursor=${encodeURIComponent(cursor)}`)
      .set(reader.headers)
      .expect(400);
  });

  it('[FEED-08] since além de janela + 1 h é limitado pelo servidor (nunca estende a janela)', async () => {
    const { reader, creator } = await readerWithPosts(0);
    const recent = await createPost(t.database.db, creator, { createdAt: ago(HOUR) });
    const slightlyOld = await createPost(t.database.db, creator, {
      createdAt: ago(72 * HOUR + 30 * MINUTE),
    });
    await createPost(t.database.db, creator, { createdAt: ago(80 * HOUR) });
    // Cursor legítimo (assinado pelo servidor) com since de 10 dias atrás.
    const codec = t.app.get(CursorCodec);
    const forged = codec.encode('feed', {
      t: 'text',
      s: ago(240 * HOUR).getTime(),
      a: recent.publishedAt!.getTime(),
      i: recent.id,
    });
    const page = await getFeed(reader.headers, `type=text&cursor=${encodeURIComponent(forged)}`);
    expect(page.items.map((item) => item.id)).toEqual([slightlyOld.id]);
  });

  it('[FEED-09] limit acima de 50 vira 50; 0, negativo ou texto → 400', async () => {
    const { reader } = await readerWithPosts(55);
    const page = await getFeed(reader.headers, 'type=text&limit=500');
    expect(page.items).toHaveLength(50);
    for (const limit of ['0', '-1', 'abc']) {
      await t.http.get(`/v1/feed?type=text&limit=${limit}`).set(reader.headers).expect(400);
    }
  });
});

describe('GET /feed: mudanças de relacionamento e contas excluídas', () => {
  it('[FEED-11] desfez a conexão: os posts somem na próxima chamada, inclusive com cursor antigo', async () => {
    const reader = await signedInUser(t.http, t.database.db);
    const friend = await createUser(t.database.db);
    await connect(t.database.db, reader.user, friend);
    for (let index = 0; index < 4; index++) {
      await createPost(t.database.db, friend, { createdAt: ago((index + 1) * MINUTE) });
    }
    const first = await getFeed(reader.headers, 'type=text&limit=2');
    expect(first.items).toHaveLength(2);
    await t.database.db.delete(connections);
    const second = await getFeed(
      reader.headers,
      `type=text&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    expect(second).toMatchObject({ items: [], caughtUp: true });
  });

  it('[FEED-12] [CONTA-02] autor que excluiu a conta: os posts somem na hora', async () => {
    const { reader, creator } = await readerWithPosts(2);
    expect((await getFeed(reader.headers, 'type=text')).items).toHaveLength(2);
    await t.database.db
      .update(users)
      .set({ deletedAt: t.clock.now() })
      .where(and(eq(users.id, creator.id)));
    expect((await getFeed(reader.headers, 'type=text')).items).toEqual([]);
  });

  it('[FEED-15] item: autor com tipo de conta, só contadores e likedByMe, mídia ready com URL assinada', async () => {
    const reader = await signedInUser(t.http, t.database.db);
    const friend = await createUser(t.database.db, { handle: 'marinac' });
    await connect(t.database.db, reader.user, friend);
    const post = await createPost(t.database.db, friend, { type: 'photo', mediaCount: 2 });
    const page = await getFeed(reader.headers, 'type=photo');
    const [item] = page.items;
    expect(item).toMatchObject({
      id: post.id,
      author: { handle: 'marinac', accountType: 'personal', avatarUrl: null },
      likeCount: 0,
      likedByMe: false,
    });
    expect(Object.keys(item!).sort()).toEqual(
      [
        'author',
        'caption',
        'commentCount',
        'createdAt',
        'id',
        'isOwn',
        'likeCount',
        'likedByMe',
        'media',
        'publishedAt',
        'status',
        'text',
        'type',
      ].sort(),
    );
    expect(item!.media.map((media) => media.position)).toEqual([0, 1]);
    for (const media of item!.media) {
      expect(new URL(media.url!).searchParams.get('Signature')).not.toBeNull();
      expect(new URL(media.thumbUrl!).pathname).toBe(`/media/${media.id}/thumb.jpg`);
    }
  });
});
