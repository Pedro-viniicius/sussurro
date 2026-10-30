import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PERSONAS,
  SEED_BLOCKS,
  SEED_FOLLOWS,
  SEED_POSTS,
  SEED_REELS,
  SEED_REPORTS,
  seedDatabase,
} from './seed.ts';
import { seedVolume, VOLUME_READER_HANDLE } from './volume.ts';
import {
  blocks,
  comments,
  connections,
  follows,
  likes,
  notifications,
  postMedia,
  posts,
  reports,
  users,
} from '../schema/index.ts';
import { createTestDatabase, TEST_PASSWORD_HASH, type TestDatabase } from '../testing/index.ts';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

const HOUR = 60 * 60 * 1000;

describe('seed (A-08)', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');

  it('cria as personas do protótipo com o tipo de conta certo e o e-mail confirmado', async () => {
    const result = await seedDatabase(testDb.db, { passwordHash: TEST_PASSWORD_HASH, now });
    expect(result.created).toEqual(PERSONAS.map((persona) => persona.handle));
    expect(result.posts).toBe(SEED_POSTS.length);
    expect(result.reels).toBe(SEED_REELS.length);
    expect(result.notifications).toBe(18);

    const rows = await testDb.db.select().from(users);
    expect(rows).toHaveLength(PERSONAS.length);
    const byHandle = new Map(rows.map((row) => [row.handle, row]));
    expect(byHandle.get('helena')).toMatchObject({ accountType: 'personal', emailVerifiedAt: now });
    expect(byHandle.get('cozinhadabia')).toMatchObject({ accountType: 'creator' });
    expect(byHandle.get('trilhasdosul')).toMatchObject({ accountType: 'creator' });
  });

  it('cria conexões, follows, posts de foto e texto dentro e fora da janela de 72 h', async () => {
    expect(await testDb.db.select().from(connections)).toHaveLength(2);
    expect(await testDb.db.select().from(follows)).toHaveLength(SEED_FOLLOWS.length);
    expect(await testDb.db.select().from(blocks)).toHaveLength(SEED_BLOCKS.length);
    expect(await testDb.db.select().from(reports)).toHaveLength(SEED_REPORTS.length);

    const allPosts = await testDb.db.select().from(posts);
    expect(allPosts.every((post) => post.status === 'published')).toBe(true);
    expect(new Set(allPosts.map((post) => post.type))).toEqual(new Set(['photo', 'text', 'reel']));
    const ages = allPosts.map((post) => now.getTime() - (post.publishedAt?.getTime() ?? 0));
    expect(ages.some((age) => age < 72 * HOUR)).toBe(true);
    expect(ages.some((age) => age > 72 * HOUR)).toBe(true);

    const media = await testDb.db.select().from(postMedia);
    expect(media.length).toBeGreaterThan(0);
    expect(media.every((item) => item.status === 'ready' && item.storageKey !== null)).toBe(true);

    // Contadores desnormalizados batem com as linhas.
    const likeRows = await testDb.db.select().from(likes);
    const commentRows = await testDb.db.select().from(comments);
    const likeTotal = allPosts.reduce((sum, post) => sum + post.likeCount, 0);
    const commentTotal = allPosts.reduce((sum, post) => sum + post.commentCount, 0);
    expect(likeTotal).toBe(likeRows.length);
    expect(commentTotal).toBe(commentRows.length);
  });

  it('[MID-14] reels de exemplo: um vídeo pronto (até 90 s, 720×1280) com poster, sem duplicar', async () => {
    const reels = (await testDb.db.select().from(posts)).filter((post) => post.type === 'reel');
    expect(reels).toHaveLength(SEED_REELS.length);
    const media = await testDb.db
      .select()
      .from(postMedia)
      .where(
        inArray(
          postMedia.postId,
          reels.map((reel) => reel.id),
        ),
      );
    expect(media).toHaveLength(reels.length);
    for (const item of media) {
      expect(item).toMatchObject({
        kind: 'video',
        position: 0,
        status: 'ready',
        storageKey: `media/${item.id}/video.mp4`,
        thumbKey: `media/${item.id}/poster.jpg`,
        width: 720,
        height: 1280,
      });
      expect(item.durationS).toBeGreaterThan(0);
      expect(item.durationS).toBeLessThanOrEqual(90);
    }
  });

  it('notificações de exemplo (Fase 6): coerentes com as curtidas, comentários, conexões e follows; seguidores anônimos', async () => {
    const rows = await testDb.db.select().from(notifications);
    const handles = new Map(
      (await testDb.db.select().from(users)).map((user) => [user.id, user.handle]),
    );
    const summary = rows
      .map((row) =>
        [
          row.type,
          handles.get(row.recipientId),
          row.actorId === null ? '-' : handles.get(row.actorId),
          row.count,
        ].join(' '),
      )
      .sort();
    expect(summary).toEqual(
      [
        'comment_replied caio.r helena 1',
        'comment_replied helena cozinhadabia 1',
        'connection_created caio.r helena 1',
        'connection_created helena caio.r 1',
        'connection_created helena marinac 1',
        'connection_created marinac helena 1',
        'new_followers cozinhadabia - 2',
        'new_followers estudioaurora - 1',
        'new_followers estudiovinil - 1',
        'new_followers trilhasdosul - 2',
        'post_commented cozinhadabia helena 1',
        'post_commented helena caio.r 1',
        'post_liked cozinhadabia caio.r 1',
        'post_liked cozinhadabia helena 1',
        'post_liked helena caio.r 1',
        'post_liked helena marinac 1',
        'post_liked marinac helena 1',
        'post_liked trilhasdosul helena 1',
      ].sort(),
    );
    // [NOT-02] Os seguidores não ficam em lugar nenhum da notificação.
    for (const row of rows.filter((item) => item.type === 'new_followers')) {
      expect(row).toMatchObject({ actorId: null, postId: null, commentId: null, payload: {} });
      expect(row.bucketKey).toBe('nf:2026-10-29');
    }
    expect(rows.every((row) => row.updatedAt.getTime() <= now.getTime())).toBe(true);
  });

  it('uma base sem reels (Fases 2 a 4) ganha só os reels; os outros posts não duplicam', async () => {
    const reelIds = (await testDb.db.select().from(posts))
      .filter((post) => post.type === 'reel')
      .map((post) => post.id);
    await testDb.db.delete(posts).where(inArray(posts.id, reelIds));
    const before = await testDb.db.select().from(posts);
    const result = await seedDatabase(testDb.db, { passwordHash: TEST_PASSWORD_HASH, now });
    expect(result).toMatchObject({ posts: 0, reels: SEED_REELS.length });
    expect(await testDb.db.select().from(posts)).toHaveLength(before.length + SEED_REELS.length);
  });

  it('é idempotente: rodar de novo não duplica nem altera', async () => {
    const before = await testDb.db.select().from(posts);
    const result = await seedDatabase(testDb.db, {
      passwordHash: TEST_PASSWORD_HASH,
      now: new Date(),
    });
    expect(result.created).toEqual([]);
    expect(result.skipped).toHaveLength(PERSONAS.length);
    expect(result.posts).toBe(0);
    expect(result.reels).toBe(0);
    expect(result.notifications).toBe(0);
    expect(await testDb.db.select().from(users)).toHaveLength(PERSONAS.length);
    expect(await testDb.db.select().from(posts)).toHaveLength(before.length);
    expect(await testDb.db.select().from(connections)).toHaveLength(2);
    expect(await testDb.db.select().from(blocks)).toHaveLength(SEED_BLOCKS.length);
    expect(await testDb.db.select().from(reports)).toHaveLength(SEED_REPORTS.length);
  });
});

describe('seed volumoso (FEED-16)', () => {
  it('cria o leitor com conexões, follows e posts; rodar de novo não faz nada', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    const options = {
      passwordHash: TEST_PASSWORD_HASH,
      now,
      connections: 5,
      creators: 7,
      posts: 120,
    };
    const result = await seedVolume(testDb.db, options);
    expect(result).toEqual({ created: true, authors: 12, posts: 120 });
    const reader = (await testDb.db.select().from(users)).find(
      (user) => user.handle === VOLUME_READER_HANDLE,
    );
    expect(reader?.emailVerifiedAt).toEqual(now);
    await expect(seedVolume(testDb.db, options)).resolves.toEqual({
      created: false,
      authors: 0,
      posts: 0,
    });
  });
});
