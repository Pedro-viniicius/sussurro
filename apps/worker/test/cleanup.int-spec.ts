// Integração dos jobs de limpeza (história 2.11, MID-11, MID-12) com as migrations reais e o S3 em
// memória. No modo postgres (compose/CI), os dois executores do teste 2.11 CA2 usam conexões
// diferentes do pool e disputam as linhas de verdade (FOR UPDATE SKIP LOCKED); no PGlite, que tem
// uma conexão só, as transações se alternam, e o teste confere o mesmo resultado: cada rascunho e
// cada objeto são apagados uma vez só.
import { avatarUploads, comments, eq, likes, postMedia, posts, users } from '@sussurro/db';
import {
  addComment,
  addLike,
  createPost,
  createTestDatabase,
  createUser,
  type TestDatabase,
} from '@sussurro/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { purgeStaleDrafts, runCleanup } from '../src/jobs/cleanup.js';
import { InMemoryObjectStorage } from '../src/testing/in-memory-storage.js';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-10-29T12:00:00.000Z');
const options = { now, draftTtlHours: 24, processingTimeoutMin: 60 };

let testDb: TestDatabase;
const storage = new InMemoryObjectStorage();

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.truncate();
  storage.clear();
});

/** Rascunho de foto com `count` originais já enviados a `incoming/`. */
async function draft(author: { id: string }, ageMs: number, count = 1) {
  const post = await createPost(testDb.db, author, {
    type: 'photo',
    status: 'draft',
    mediaCount: count,
    createdAt: new Date(now.getTime() - ageMs),
  });
  for (const media of post.media) {
    storage.objects.set(media.incomingKey, { body: Buffer.from('x'), contentType: 'image/jpeg' });
  }
  return post;
}

describe('rascunhos órfãos (2.11 CA1, MID-12)', () => {
  it('[MID-12] rascunho de 25 h sai com os objetos de incoming/; o de 23 h fica', async () => {
    const author = await createUser(testDb.db);
    const old = await draft(author, 25 * HOUR, 2);
    const fresh = await draft(author, 23 * HOUR);
    const published = await createPost(testDb.db, author, {
      type: 'photo',
      createdAt: new Date(now.getTime() - 30 * HOUR),
    });

    const result = await runCleanup(testDb.db, storage, options);

    expect(result).toMatchObject({ drafts: 1, deletedPosts: 0 });
    const ids = (await testDb.db.select({ id: posts.id }).from(posts)).map((row) => row.id);
    expect(ids.sort()).toEqual([fresh.id, published.id].sort());
    expect([...storage.deletedKeys].sort()).toEqual(
      old.media.map((media) => media.incomingKey).sort(),
    );
    expect(storage.objects.has(fresh.media[0]!.incomingKey)).toBe(true);
    expect(
      await testDb.db.select().from(postMedia).where(eq(postMedia.postId, old.id)),
    ).toHaveLength(0);
  });

  it('[MID-12] 2.11 CA2: dois executores ao mesmo tempo apagam cada rascunho e objeto uma vez só', async () => {
    const author = await createUser(testDb.db);
    const drafts = [];
    for (let index = 0; index < 120; index++) {
      drafts.push(await draft(author, 25 * HOUR + index * 1000));
    }
    const cutoff = new Date(now.getTime() - 24 * HOUR);

    const [first, second] = await Promise.all([
      purgeStaleDrafts(testDb.db, storage, cutoff, 25),
      purgeStaleDrafts(testDb.db, storage, cutoff, 25),
    ]);

    expect(first.posts + second.posts).toBe(120);
    expect(first.objects + second.objects).toBe(120);
    expect(storage.deletedKeys).toHaveLength(120);
    expect(new Set(storage.deletedKeys).size).toBe(120);
    expect(await testDb.db.select().from(posts)).toHaveLength(0);
  });

  it('se o S3 falhar, o lote é desfeito e o rascunho fica para o próximo ciclo', async () => {
    const author = await createUser(testDb.db);
    await draft(author, 25 * HOUR);
    storage.failNextDelete = true;
    await expect(runCleanup(testDb.db, storage, options)).rejects.toThrow(/S3 indisponível/);
    expect(await testDb.db.select().from(posts)).toHaveLength(1);
    await expect(runCleanup(testDb.db, storage, options)).resolves.toMatchObject({ drafts: 1 });
  });
});

describe('posts apagados (2.9 CA3, MID-11)', () => {
  it('[MID-11] objetos de media/ (full e thumb) e a linha saem; curtidas e comentários em cascata', async () => {
    const author = await createUser(testDb.db, { accountType: 'creator' });
    const fan = await createUser(testDb.db);
    const removed = await createPost(testDb.db, author, {
      type: 'photo',
      mediaCount: 2,
      deletedAt: new Date(now.getTime() - 60_000),
    });
    const kept = await createPost(testDb.db, author, { type: 'photo' });
    await addLike(testDb.db, removed, fan);
    await addComment(testDb.db, removed, fan);
    await createPost(testDb.db, author, { deletedAt: now }); // texto apagado: só a linha

    const result = await runCleanup(testDb.db, storage, options);

    expect(result.deletedPosts).toBe(2);
    expect(storage.deletedKeys).toEqual(
      expect.arrayContaining(
        removed.media.flatMap((media) => [media.storageKey!, media.thumbKey!]),
      ),
    );
    expect(storage.deletedKeys).not.toContain(kept.media[0]!.storageKey);
    expect((await testDb.db.select({ id: posts.id }).from(posts)).map((row) => row.id)).toEqual([
      kept.id,
    ]);
    expect(await testDb.db.select().from(likes)).toHaveLength(0);
    expect(await testDb.db.select().from(comments)).toHaveLength(0);
  });
});

describe('mídia travada e uploads de avatar', () => {
  it('[MID-10] mídia em processing há mais de 60 min vira failed, com o post', async () => {
    const author = await createUser(testDb.db);
    const stuck = await createPost(testDb.db, author, {
      type: 'photo',
      status: 'processing',
      createdAt: new Date(now.getTime() - 2 * HOUR),
    });
    const recent = await createPost(testDb.db, author, {
      type: 'photo',
      status: 'processing',
      createdAt: new Date(now.getTime() - 10 * 60_000),
    });

    const result = await runCleanup(testDb.db, storage, options);

    expect(result.stuckMedia).toBe(1);
    const status = async (id: string) =>
      (await testDb.db.select().from(posts).where(eq(posts.id, id)))[0]?.status;
    expect(await status(stuck.id)).toBe('failed');
    expect(await status(recent.id)).toBe('processing');
  });

  it('uploads de avatar com mais de 24 h saem; a foto em uso fica no S3', async () => {
    const user = await createUser(testDb.db);
    const current = 'media/atual/avatar.jpg';
    await testDb.db.update(users).set({ avatarKey: current }).where(eq(users.id, user.id));
    const old = new Date(now.getTime() - 25 * HOUR);
    await testDb.db.insert(avatarUploads).values([
      {
        userId: user.id,
        mime: 'image/jpeg',
        sizeBytes: 10,
        incomingKey: 'incoming/u/em-uso',
        storageKey: current,
        status: 'ready',
        createdAt: old,
      },
      {
        userId: user.id,
        mime: 'image/jpeg',
        sizeBytes: 10,
        incomingKey: 'incoming/u/abandonado',
        createdAt: old,
      },
      {
        userId: user.id,
        mime: 'image/jpeg',
        sizeBytes: 10,
        incomingKey: 'incoming/u/recente',
        createdAt: now,
      },
    ]);

    const result = await runCleanup(testDb.db, storage, options);

    expect(result.avatarUploads).toBe(2);
    expect([...storage.deletedKeys].sort()).toEqual(['incoming/u/abandonado', 'incoming/u/em-uso']);
    expect(await testDb.db.select().from(avatarUploads)).toHaveLength(1);
  });
});
