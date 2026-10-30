// Integração do job de manutenção (CONTA-05, A-12) com as migrations reais, no Postgres do compose
// ou no PGlite (TEST_DB=pglite), e o S3 em memória.
import {
  avatarUploads,
  comments,
  connectionRequests,
  connections,
  emailTokens,
  eq,
  likes,
  posts,
  refreshTokens,
  retiredHandles,
  users,
} from '@sussurro/db';
import {
  addComment,
  addLike,
  connect,
  createPost,
  createTestDatabase,
  createUser,
  type TestDatabase,
} from '@sussurro/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { purgeDeletedAccounts, runMaintenance } from '../src/jobs/maintenance.js';
import { InMemoryObjectStorage } from '../src/testing/in-memory-storage.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-12-01T12:00:00.000Z');
const options = { now, purgeAfterDays: 30, draftTtlHours: 24, processingTimeoutMin: 60 };

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

async function addSession(userId: string, expiresAt: Date, seed: number) {
  await testDb.db.insert(refreshTokens).values({
    userId,
    familyId: userId,
    tokenHash: new Uint8Array(32).fill(seed),
    expiresAt,
  });
}

async function postRow(id: string) {
  const [row] = await testDb.db.select().from(posts).where(eq(posts.id, id));
  return row;
}

describe('job de manutenção do worker', () => {
  it('[CONTA-05] apaga só contas excluídas há mais de 30 dias, com sessões e links em cascata', async () => {
    const old = await createUser(testDb.db, {
      handle: 'excluida.antiga',
      deletedAt: new Date(now.getTime() - 31 * DAY),
    });
    const recent = await createUser(testDb.db, {
      handle: 'excluida.recente',
      deletedAt: new Date(now.getTime() - 29 * DAY),
    });
    const active = await createUser(testDb.db, { handle: 'ativa' });
    await testDb.db.insert(retiredHandles).values({ handle: 'excluida.antiga' });
    await addSession(old.id, new Date(now.getTime() + DAY), 1);
    await testDb.db.insert(emailTokens).values({
      userId: old.id,
      purpose: 'verify_email',
      email: old.email,
      tokenHash: new Uint8Array(32).fill(2),
      expiresAt: new Date(now.getTime() + DAY),
    });

    const result = await runMaintenance(testDb.db, storage, options);

    expect(result.purgedAccounts).toBe(1);
    const remaining = (await testDb.db.select({ id: users.id }).from(users)).map((row) => row.id);
    expect(remaining.sort()).toEqual([recent.id, active.id].sort());
    expect(await testDb.db.select().from(refreshTokens)).toHaveLength(0);
    expect(await testDb.db.select().from(emailTokens)).toHaveLength(0);
    // O @ aposentado sobrevive ao hard delete (A-14).
    expect(await testDb.db.select().from(retiredHandles)).toHaveLength(1);
  });

  it('[CONTA-05] o hard delete apaga do S3 a mídia dos posts, o avatar e os uploads de avatar', async () => {
    const gone = await createUser(testDb.db, { deletedAt: new Date(now.getTime() - 31 * DAY) });
    const keep = await createUser(testDb.db);
    const goneAvatar = 'media/avatar-antigo/avatar.jpg';
    await testDb.db.update(users).set({ avatarKey: goneAvatar }).where(eq(users.id, gone.id));
    const post = await createPost(testDb.db, gone, { type: 'photo', mediaCount: 2 });
    const kept = await createPost(testDb.db, keep, { type: 'photo', mediaCount: 1 });
    await testDb.db.insert(avatarUploads).values({
      userId: gone.id,
      mime: 'image/jpeg',
      sizeBytes: 10,
      incomingKey: `incoming/${gone.id}/upload`,
    });
    const goneKeys = [
      goneAvatar,
      `incoming/${gone.id}/upload`,
      ...post.media.flatMap((media) => [media.incomingKey, media.storageKey!, media.thumbKey!]),
    ];
    for (const key of [...goneKeys, kept.media[0]!.storageKey!]) {
      storage.objects.set(key, { body: Buffer.from('x'), contentType: 'image/jpeg' });
    }

    const result = await runMaintenance(testDb.db, storage, options);

    expect(result.purgedObjects).toBe(goneKeys.length);
    expect([...storage.deletedKeys].sort()).toEqual([...goneKeys].sort());
    expect([...storage.objects.keys()]).toEqual([kept.media[0]!.storageKey]);
    expect(await postRow(post.id)).toBeUndefined();
  });

  it('[CNT-04] [A-12] recalcula like_count e comment_count dos posts que a conta curtiu ou comentou', async () => {
    const creator = await createUser(testDb.db, { accountType: 'creator' });
    const post = await createPost(testDb.db, creator);
    const gone = await createUser(testDb.db, { deletedAt: new Date(now.getTime() - 31 * DAY) });
    const fan = await createUser(testDb.db);
    // Curtidas e comentários que sobraram nas linhas (ex.: conta excluída antes da Fase 2): o
    // cascade apaga as linhas, mas só o recálculo acerta os números.
    await addLike(testDb.db, post, gone);
    await addLike(testDb.db, post, fan);
    const parent = await addComment(testDb.db, post, gone);
    await addComment(testDb.db, post, fan, { parentId: parent.id });
    await addComment(testDb.db, post, fan);
    expect(await postRow(post.id)).toMatchObject({ likeCount: 2, commentCount: 3 });

    const result = await runMaintenance(testDb.db, storage, options);

    expect(result.recalculatedPosts).toBe(1);
    expect(await postRow(post.id)).toMatchObject({ likeCount: 1, commentCount: 1 });
    expect(await testDb.db.select().from(likes)).toHaveLength(1);
    expect(await testDb.db.select().from(comments)).toHaveLength(1);
  });

  it('se o S3 falhar, o lote é desfeito e a conta fica para o próximo ciclo', async () => {
    const gone = await createUser(testDb.db, { deletedAt: new Date(now.getTime() - 31 * DAY) });
    await createPost(testDb.db, gone, { type: 'photo' });
    storage.failNextDelete = true;
    await expect(purgeDeletedAccounts(testDb.db, storage, now)).rejects.toThrow(/S3 indisponível/);
    expect(await testDb.db.select().from(users)).toHaveLength(1);
    await expect(purgeDeletedAccounts(testDb.db, storage, now)).resolves.toMatchObject({
      accounts: 1,
    });
  });

  it('apaga em lotes até acabar', async () => {
    for (let index = 0; index < 5; index++) {
      await createUser(testDb.db, { deletedAt: new Date(now.getTime() - 40 * DAY) });
    }
    await expect(purgeDeletedAccounts(testDb.db, storage, now, 2)).resolves.toMatchObject({
      accounts: 5,
    });
    expect(await testDb.db.select().from(users)).toHaveLength(0);
  });

  it('remove refresh tokens e links de e-mail vencidos, mantendo os válidos', async () => {
    const user = await createUser(testDb.db);
    await addSession(user.id, new Date(now.getTime() - 1), 3);
    await addSession(user.id, new Date(now.getTime() + DAY), 4);

    const result = await runMaintenance(testDb.db, storage, options);

    expect(result).toMatchObject({
      purgedAccounts: 0,
      deletedRefreshTokens: 1,
      deletedEmailTokens: 0,
    });
    expect(await testDb.db.select().from(refreshTokens)).toHaveLength(1);
  });
});

describe('pedidos de conexão (Fase 4)', () => {
  async function addRequest(
    fromId: string,
    toId: string,
    values: { status?: 'pending' | 'accepted' | 'declined'; createdAt: Date },
  ) {
    const status = values.status ?? 'pending';
    const [row] = await testDb.db
      .insert(connectionRequests)
      .values({
        fromId,
        toId,
        method: 'ble',
        status,
        createdAt: values.createdAt,
        expiresAt: new Date(values.createdAt.getTime() + 120_000),
        respondedAt: status === 'pending' ? null : values.createdAt,
      })
      .returning();
    return row!;
  }

  it('[PROX-15] marca como expired os pendentes vencidos; apaga os encerrados há mais de 30 dias, mantendo a conexão', async () => {
    const [a, b, c, d] = await Promise.all([
      createUser(testDb.db),
      createUser(testDb.db),
      createUser(testDb.db),
      createUser(testDb.db),
    ]);
    const stale = await addRequest(a.id, b.id, { createdAt: new Date(now.getTime() - 121_000) });
    const alive = await addRequest(a.id, c.id, { createdAt: new Date(now.getTime() - 60_000) });
    const old = await addRequest(c.id, d.id, {
      status: 'accepted',
      createdAt: new Date(now.getTime() - 31 * DAY),
    });
    const recent = await addRequest(b.id, d.id, {
      status: 'declined',
      createdAt: new Date(now.getTime() - 29 * DAY),
    });
    await connect(testDb.db, c, d);
    await testDb.db.update(connections).set({ requestId: old.id });

    const result = await runMaintenance(testDb.db, storage, options);

    expect(result).toMatchObject({ expiredConnectionRequests: 1, deletedConnectionRequests: 1 });
    const rows = await testDb.db.select().from(connectionRequests);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(stale.id)).toMatchObject({ status: 'expired', respondedAt: now });
    expect(byId.get(alive.id)?.status).toBe('pending');
    expect(byId.has(old.id)).toBe(false);
    expect(byId.get(recent.id)?.status).toBe('declined');
    const [connection] = await testDb.db.select().from(connections);
    expect(connection?.requestId).toBeNull();
  });
});
