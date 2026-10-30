// Integração do schema da Fase 6 (notificações, push tokens e tickets; ADR 0011), com as
// migrations reais, no Postgres do compose ou no PGlite (TEST_DB=pglite).
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findPgError, PgErrorCode } from './errors.ts';
import { notifications, pushTickets, pushTokens, users } from './schema/index.ts';
import {
  addComment,
  createPost,
  createTestDatabase,
  createUser,
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

const NOW = new Date('2026-10-30T12:00:00.000Z');
const TOKEN = 'ExponentPushToken[aparelho-de-teste-1]';

async function pgErrorOf(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('era esperado um erro do banco');
}

function insert(values: Partial<typeof notifications.$inferInsert> & { recipientId: string }) {
  return testDb.db
    .insert(notifications)
    .values({ type: 'post_liked', createdAt: NOW, updatedAt: NOW, ...values })
    .returning();
}

describe('notifications (ADR 0011)', () => {
  it('[NOT-02] seguidores: actor_id, post_id, comment_id nulos e payload vazio garantidos pelo CHECK', async () => {
    const creator = await createUser(testDb.db, { accountType: 'creator' });
    const follower = await createUser(testDb.db);
    const post = await createPost(testDb.db, creator);
    const followers = {
      recipientId: creator.id,
      type: 'new_followers' as const,
      bucketKey: 'nf:2026-10-30',
    };

    expect(
      (await pgErrorOf(() => insert({ ...followers, actorId: follower.id })))?.constraint,
    ).toBe('notifications_new_followers_anonymous_chk');
    expect((await pgErrorOf(() => insert({ ...followers, postId: post.id })))?.code).toBe(
      PgErrorCode.CHECK_VIOLATION,
    );
    expect(
      (await pgErrorOf(() => insert({ ...followers, payload: { followerIds: [follower.id] } })))
        ?.constraint,
    ).toBe('notifications_new_followers_anonymous_chk');
    const [row] = await insert({ ...followers, count: 3 });
    expect(row).toMatchObject({
      actorId: null,
      postId: null,
      commentId: null,
      payload: {},
      count: 3,
    });
  });

  it('seguidores: um por dia por conta (bucket único) e no formato nf:YYYY-MM-DD', async () => {
    const creator = await createUser(testDb.db, { accountType: 'creator' });
    const followers = { recipientId: creator.id, type: 'new_followers' as const };
    await insert({ ...followers, bucketKey: 'nf:2026-10-30' });
    expect(
      (await pgErrorOf(() => insert({ ...followers, bucketKey: 'nf:2026-10-30' })))?.code,
    ).toBe(PgErrorCode.UNIQUE_VIOLATION);
    await insert({ ...followers, bucketKey: 'nf:2026-10-31' });
    expect((await pgErrorOf(() => insert({ ...followers, bucketKey: 'ontem' })))?.code).toBe(
      PgErrorCode.CHECK_VIOLATION,
    );
    expect((await pgErrorOf(() => insert({ ...followers })))?.code).toBe(
      PgErrorCode.CHECK_VIOLATION,
    );
  });

  it('[NOT-07] curtida: uma por (quem recebe, quem curtiu, post); nunca da própria ação; contagem 1', async () => {
    const author = await createUser(testDb.db, { accountType: 'creator' });
    const fan = await createUser(testDb.db);
    const post = await createPost(testDb.db, author);
    const like = { recipientId: author.id, actorId: fan.id, postId: post.id };
    await insert(like);
    expect((await pgErrorOf(() => insert(like)))?.code).toBe(PgErrorCode.UNIQUE_VIOLATION);
    expect(
      (
        await pgErrorOf(() =>
          insert({ recipientId: author.id, actorId: author.id, postId: post.id }),
        )
      )?.constraint,
    ).toBe('notifications_not_self_chk');
    expect((await pgErrorOf(() => insert({ ...like, count: 2 })))?.code).toBe(
      PgErrorCode.CHECK_VIOLATION,
    );
    // Curtida sem post ou com comentário não existe.
    expect(
      (await pgErrorOf(() => insert({ recipientId: author.id, actorId: fan.id })))?.constraint,
    ).toBe('notifications_post_chk');
  });

  it('[NOT-09] post, comentário ou conta apagados de vez levam a notificação em cascata', async () => {
    const author = await createUser(testDb.db, { accountType: 'creator' });
    const fan = await createUser(testDb.db);
    const post = await createPost(testDb.db, author);
    const comment = await addComment(testDb.db, post, fan);
    await insert({ recipientId: author.id, actorId: fan.id, postId: post.id });
    await insert({
      recipientId: author.id,
      actorId: fan.id,
      postId: post.id,
      commentId: comment.id,
      type: 'post_commented',
    });
    await testDb.db.delete(users).where(eq(users.id, fan.id));
    expect(await testDb.db.select().from(notifications)).toEqual([]);
  });
});

describe('push_tokens e push_tickets (6.4, 6.5)', () => {
  it('token único, no formato do Expo, plataforma ios/android; a conta apagada leva os tokens e os tickets', async () => {
    const person = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const values = {
      userId: person.id,
      expoToken: TOKEN,
      platform: 'ios',
      refreshFamilyId: person.id,
      createdAt: NOW,
      lastSeenAt: NOW,
    };
    const [token] = await testDb.db.insert(pushTokens).values(values).returning();
    expect(
      (await pgErrorOf(() => testDb.db.insert(pushTokens).values({ ...values, userId: other.id })))
        ?.code,
    ).toBe(PgErrorCode.UNIQUE_VIOLATION);
    for (const [expoToken, platform] of [
      ['token-qualquer', 'ios'],
      ['ExponentPushToken[com espaço]', 'ios'],
      ['ExponentPushToken[ok-2]', 'web'],
    ] as const) {
      expect(
        (
          await pgErrorOf(() =>
            testDb.db.insert(pushTokens).values({ ...values, expoToken, platform }),
          )
        )?.code,
        expoToken,
      ).toBe(PgErrorCode.CHECK_VIOLATION);
    }
    await testDb.db
      .insert(pushTickets)
      .values({ ticketId: 'ticket-1', pushTokenId: token!.id, createdAt: NOW });
    await testDb.db.delete(users).where(eq(users.id, person.id));
    const remaining = await testDb.db.execute(
      sql`select (select count(*) from push_tokens)::int as tokens, (select count(*) from push_tickets)::int as tickets`,
    );
    expect((remaining as { rows: unknown[] }).rows[0]).toEqual({
      tokens: 0,
      tickets: 0,
    });
  });
});
