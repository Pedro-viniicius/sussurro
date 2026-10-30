// Integração do schema da Fase 2 (posts, mídia, curtidas, comentários, conexões e follows), com as
// migrations reais, no Postgres do compose ou no PGlite (TEST_DB=pglite).
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findPgError, PgErrorCode } from './errors.ts';
import { comments, connections, follows, likes, postMedia, posts, users } from './schema/index.ts';
import {
  addComment,
  addLike,
  connect,
  createPost,
  createUser,
  createTestDatabase,
  follow,
  type TestDatabase,
} from './testing/index.ts';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.truncate();
});

async function pgErrorOf(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('era esperado um erro do banco');
}

describe('connections e follows: tipo de conta no banco (ADR 0008)', () => {
  it('[PERM-06] conexão com um lado criador é recusada pela FK composta', async () => {
    const person = await createUser(testDb.db);
    const creator = await createUser(testDb.db, { accountType: 'creator' });
    const [a, b] = [person.id, creator.id].sort();
    const error = await pgErrorOf(() =>
      testDb.db.insert(connections).values({ userAId: a!, userBId: b!, method: 'ble' }),
    );
    expect(error?.code).toBe(PgErrorCode.FOREIGN_KEY_VIOLATION);
  });

  it('[PERM-06] par fora de ordem (user_a_id >= user_b_id) é recusado', async () => {
    const first = await createUser(testDb.db);
    const second = await createUser(testDb.db);
    const [a, b] = [first.id, second.id].sort();
    expect(
      await pgErrorOf(() =>
        testDb.db.insert(connections).values({ userAId: b!, userBId: a!, method: 'qr' }),
      ),
    ).toEqual({ code: PgErrorCode.CHECK_VIOLATION, constraint: 'connections_ordered_pair_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db.insert(connections).values({ userAId: a!, userBId: a!, method: 'qr' }),
      ),
    ).toEqual({ code: PgErrorCode.CHECK_VIOLATION, constraint: 'connections_ordered_pair_chk' });
  });

  it('[PERM-02] follow com seguidor criador ou alvo pessoal é recusado pela FK composta', async () => {
    const person = await createUser(testDb.db);
    const otherPerson = await createUser(testDb.db);
    const creator = await createUser(testDb.db, { accountType: 'creator' });
    const otherCreator = await createUser(testDb.db, { accountType: 'creator' });
    expect(
      (
        await pgErrorOf(() =>
          testDb.db.insert(follows).values({ followerId: creator.id, creatorId: otherCreator.id }),
        )
      )?.code,
    ).toBe(PgErrorCode.FOREIGN_KEY_VIOLATION);
    expect(
      (
        await pgErrorOf(() =>
          testDb.db.insert(follows).values({ followerId: person.id, creatorId: otherPerson.id }),
        )
      )?.code,
    ).toBe(PgErrorCode.FOREIGN_KEY_VIOLATION);
    await follow(testDb.db, person, creator);
    expect(await testDb.db.select().from(follows)).toHaveLength(1);
  });

  it('o hard delete de uma conta apaga conexões e follows em cascata', async () => {
    const person = await createUser(testDb.db);
    const friend = await createUser(testDb.db);
    const creator = await createUser(testDb.db, { accountType: 'creator' });
    await connect(testDb.db, person, friend);
    await follow(testDb.db, person, creator);
    await testDb.db.delete(users).where(eq(users.id, person.id));
    expect(await testDb.db.select().from(connections)).toHaveLength(0);
    expect(await testDb.db.select().from(follows)).toHaveLength(0);
  });
});

describe('posts: constraints', () => {
  it('[TXT-01] texto de 1 a 280 code points (emoji = 1, como a contagem do app)', async () => {
    const author = await createUser(testDb.db);
    await expect(createPost(testDb.db, author, { text: '😀'.repeat(280) })).resolves.toMatchObject({
      type: 'text',
    });
    expect(await pgErrorOf(() => createPost(testDb.db, author, { text: 'a'.repeat(281) }))).toEqual(
      { code: PgErrorCode.CHECK_VIOLATION, constraint: 'posts_text_length_chk' },
    );
  });

  it('texto só em post de texto, que nasce publicado; legenda só em foto (até 2200)', async () => {
    const author = await createUser(testDb.db);
    const base = { authorId: author.id, status: 'published' as const, publishedAt: new Date() };
    expect(
      await pgErrorOf(() => testDb.db.insert(posts).values({ ...base, type: 'text' })),
    ).toMatchObject({ constraint: 'posts_text_type_chk' });
    expect(
      await pgErrorOf(() => testDb.db.insert(posts).values({ ...base, type: 'photo', text: 'oi' })),
    ).toMatchObject({ constraint: 'posts_text_type_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db
          .insert(posts)
          .values({ authorId: author.id, type: 'text', text: 'oi', status: 'draft' }),
      ),
    ).toMatchObject({ constraint: 'posts_text_published_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db.insert(posts).values({ ...base, type: 'photo', caption: 'a'.repeat(2201) }),
      ),
    ).toMatchObject({ constraint: 'posts_caption_chk' });
  });

  it('published_at existe só em published e tem precisão de milissegundo (cursor do feed)', async () => {
    const author = await createUser(testDb.db);
    expect(
      await pgErrorOf(() =>
        testDb.db.insert(posts).values({ authorId: author.id, type: 'photo', status: 'published' }),
      ),
    ).toMatchObject({ constraint: 'posts_published_at_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db.execute(
          sql`insert into posts (author_id, type, status, published_at)
              values (${author.id}, 'photo', 'published', '2026-10-29T12:00:00.123456Z')`,
        ),
      ),
    ).toEqual({ code: PgErrorCode.CHECK_VIOLATION, constraint: 'posts_published_at_ms_chk' });
    await expect(
      createPost(testDb.db, author, { publishedAt: new Date('2026-10-29T12:00:00.123Z') }),
    ).resolves.toMatchObject({ publishedAt: new Date('2026-10-29T12:00:00.123Z') });
  });

  it('[CNT-04] contadores nunca ficam negativos', async () => {
    const author = await createUser(testDb.db);
    const post = await createPost(testDb.db, author);
    expect(
      await pgErrorOf(() =>
        testDb.db.update(posts).set({ likeCount: -1 }).where(eq(posts.id, post.id)),
      ),
    ).toMatchObject({ constraint: 'posts_like_count_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db.update(posts).set({ commentCount: -1 }).where(eq(posts.id, post.id)),
      ),
    ).toMatchObject({ constraint: 'posts_comment_count_chk' });
  });

  it('[MID-01] no máximo 4 imagens por post, posição única', async () => {
    const author = await createUser(testDb.db);
    const post = await createPost(testDb.db, author, { type: 'photo', mediaCount: 4 });
    expect(post.media.map((media) => media.position)).toEqual([0, 1, 2, 3]);
    const base = {
      postId: post.id,
      kind: 'image' as const,
      mime: 'image/jpeg',
      sizeBytes: 10,
      incomingKey: 'incoming/x',
    };
    expect(
      await pgErrorOf(() => testDb.db.insert(postMedia).values({ ...base, position: 4 })),
    ).toMatchObject({ constraint: 'post_media_position_chk' });
    expect(
      await pgErrorOf(() => testDb.db.insert(postMedia).values({ ...base, position: 0 })),
    ).toMatchObject({ code: PgErrorCode.UNIQUE_VIOLATION });
  });
});

describe('curtidas e comentários', () => {
  it('[CNT-04] uma curtida por pessoa e post (PK)', async () => {
    const author = await createUser(testDb.db);
    const fan = await createUser(testDb.db);
    const post = await createPost(testDb.db, author);
    await addLike(testDb.db, post, fan);
    expect(
      await pgErrorOf(() => testDb.db.insert(likes).values({ postId: post.id, userId: fan.id })),
    ).toMatchObject({ code: PgErrorCode.UNIQUE_VIOLATION });
  });

  it('[TXT-04] comentário de 1 a 500 code points', async () => {
    const author = await createUser(testDb.db);
    const post = await createPost(testDb.db, author);
    await expect(
      addComment(testDb.db, post, author, { body: '😀'.repeat(500) }),
    ).resolves.toMatchObject({ postId: post.id });
    expect(
      await pgErrorOf(() => addComment(testDb.db, post, author, { body: 'a'.repeat(501) })),
    ).toMatchObject({ constraint: 'comments_body_length_chk' });
    expect(await pgErrorOf(() => addComment(testDb.db, post, author, { body: '' }))).toMatchObject({
      constraint: 'comments_body_length_chk',
    });
  });

  it('apagar o post apaga mídia, curtidas e comentários em cascata', async () => {
    const author = await createUser(testDb.db);
    const fan = await createUser(testDb.db);
    const post = await createPost(testDb.db, author, { type: 'photo', mediaCount: 2 });
    await addLike(testDb.db, post, fan);
    const parent = await addComment(testDb.db, post, fan);
    await addComment(testDb.db, post, author, { parentId: parent.id });
    await testDb.db.delete(posts).where(eq(posts.id, post.id));
    expect(await testDb.db.select().from(postMedia)).toHaveLength(0);
    expect(await testDb.db.select().from(likes)).toHaveLength(0);
    expect(await testDb.db.select().from(comments)).toHaveLength(0);
  });
});

describe('reels: vídeo e poster (Fase 5, ADR 0006)', () => {
  it('[MID-14] o reel da factory tem um vídeo na posição 0, com duração e poster em incoming/', async () => {
    const author = await createUser(testDb.db);
    const reel = await createPost(testDb.db, author, { type: 'reel' });
    expect(reel.media).toHaveLength(1);
    expect(reel.media[0]).toMatchObject({
      kind: 'video',
      position: 0,
      durationS: 42,
      storageKey: `media/${reel.media[0]!.id}/video.mp4`,
      thumbKey: `media/${reel.media[0]!.id}/poster.jpg`,
      posterIncomingKey: `${reel.media[0]!.incomingKey}-poster`,
    });
  });

  it('vídeo sem duração ou com duração zero é recusado; a duração volta como número', async () => {
    const author = await createUser(testDb.db);
    const reel = await createPost(testDb.db, author, { type: 'reel', status: 'draft' });
    const [media] = reel.media;
    for (const durationS of [null, 0, -1]) {
      expect(
        await pgErrorOf(() =>
          testDb.db.update(postMedia).set({ durationS }).where(eq(postMedia.id, media!.id)),
        ),
      ).toMatchObject({ constraint: 'post_media_video_duration_chk' });
    }
    await testDb.db.update(postMedia).set({ durationS: 89.99 }).where(eq(postMedia.id, media!.id));
    const [row] = await testDb.db.select().from(postMedia).where(eq(postMedia.id, media!.id));
    expect(row?.durationS).toBe(89.99);
  });

  it('poster só no vídeo e sempre completo (chave, tipo e tamanho positivo)', async () => {
    const author = await createUser(testDb.db);
    const photo = await createPost(testDb.db, author, { type: 'photo', status: 'draft' });
    const reel = await createPost(testDb.db, author, { type: 'reel', status: 'draft' });
    expect(
      await pgErrorOf(() =>
        testDb.db
          .update(postMedia)
          .set({
            posterIncomingKey: 'incoming/x/y-poster',
            posterMime: 'image/jpeg',
            posterSizeBytes: 10,
          })
          .where(eq(postMedia.id, photo.media[0]!.id)),
      ),
    ).toMatchObject({ constraint: 'post_media_poster_video_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db
          .update(postMedia)
          .set({ posterMime: null })
          .where(eq(postMedia.id, reel.media[0]!.id)),
      ),
    ).toMatchObject({ constraint: 'post_media_poster_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db
          .update(postMedia)
          .set({ posterSizeBytes: 0 })
          .where(eq(postMedia.id, reel.media[0]!.id)),
      ),
    ).toMatchObject({ constraint: 'post_media_poster_size_chk' });
  });

  it('vídeo só na posição 0 (um reel não ganha um segundo vídeo)', async () => {
    const author = await createUser(testDb.db);
    const reel = await createPost(testDb.db, author, { type: 'reel', status: 'draft' });
    expect(
      await pgErrorOf(() =>
        testDb.db.update(postMedia).set({ position: 1 }).where(eq(postMedia.id, reel.media[0]!.id)),
      ),
    ).toMatchObject({ constraint: 'post_media_video_position_chk' });
  });
});
