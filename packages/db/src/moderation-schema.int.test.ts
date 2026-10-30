// Integração do schema da Fase 3 (bloqueios, denúncias e o índice da busca de criadores), com as
// migrations reais, no Postgres do compose ou no PGlite (TEST_DB=pglite).
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findPgError, PgErrorCode } from './errors.ts';
import { blocks, comments, posts, reports, users } from './schema/index.ts';
import {
  addComment,
  block,
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

async function pgErrorOf(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('era esperado um erro do banco');
}

describe('blocks (X.2)', () => {
  it('um bloqueio por par e sentido; a si mesmo é recusado; os dois sentidos podem existir', async () => {
    const first = await createUser(testDb.db);
    const second = await createUser(testDb.db, { accountType: 'creator' });
    await block(testDb.db, first, second);
    expect((await pgErrorOf(() => block(testDb.db, first, second)))?.code).toBe(
      PgErrorCode.UNIQUE_VIOLATION,
    );
    expect(await pgErrorOf(() => block(testDb.db, first, first))).toEqual({
      code: PgErrorCode.CHECK_VIOLATION,
      constraint: 'blocks_not_self_chk',
    });
    await block(testDb.db, second, first);
    expect(await testDb.db.select().from(blocks)).toHaveLength(2);
  });

  it('o hard delete de qualquer lado apaga o bloqueio em cascata', async () => {
    const blocker = await createUser(testDb.db);
    const blocked = await createUser(testDb.db);
    await block(testDb.db, blocker, blocked);
    await testDb.db.delete(users).where(eq(users.id, blocked.id));
    expect(await testDb.db.select().from(blocks)).toHaveLength(0);
  });
});

describe('reports (X.1)', () => {
  it('alvo coerente com o tipo; motivo da lista; detalhes de 1 a 500; sem denunciar a si mesmo', async () => {
    const reporter = await createUser(testDb.db);
    const author = await createUser(testDb.db, { accountType: 'creator' });
    const post = await createPost(testDb.db, author);
    const comment = await addComment(testDb.db, post, author);
    const base = { reporterId: reporter.id, targetUserId: author.id, reason: 'spam' as const };

    await testDb.db.insert(reports).values({ ...base, targetType: 'post', postId: post.id });
    await testDb.db
      .insert(reports)
      .values({ ...base, targetType: 'comment', commentId: comment.id, details: 'x'.repeat(500) });
    await testDb.db.insert(reports).values({ ...base, targetType: 'account' });

    expect(
      await pgErrorOf(() =>
        testDb.db
          .insert(reports)
          .values({ ...base, targetType: 'account', postId: post.id, reason: 'hate' }),
      ),
    ).toEqual({ code: PgErrorCode.CHECK_VIOLATION, constraint: 'reports_target_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db.insert(reports).values({ ...base, targetType: 'post', commentId: comment.id }),
      ),
    ).toEqual({ code: PgErrorCode.CHECK_VIOLATION, constraint: 'reports_target_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db
          .insert(reports)
          .values({ ...base, targetType: 'post', postId: post.id, details: 'x'.repeat(501) }),
      ),
    ).toEqual({ code: PgErrorCode.CHECK_VIOLATION, constraint: 'reports_details_chk' });
    expect(
      await pgErrorOf(() =>
        testDb.db.insert(reports).values({
          ...base,
          targetUserId: reporter.id,
          targetType: 'account',
        }),
      ),
    ).toEqual({ code: PgErrorCode.CHECK_VIOLATION, constraint: 'reports_not_self_chk' });
    expect(
      (
        await pgErrorOf(() =>
          testDb.db.execute(
            sql`insert into reports (reporter_id, target_type, target_user_id, reason)
                values (${reporter.id}, 'account', ${author.id}, 'outro')`,
          ),
        )
      )?.code,
    ).toBe('22P02');
  });

  it('a mesma pessoa denunciando o mesmo alvo de novo não cria outra linha (idempotência)', async () => {
    const reporter = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const author = await createUser(testDb.db, { accountType: 'creator' });
    const post = await createPost(testDb.db, author);
    const values = {
      reporterId: reporter.id,
      targetUserId: author.id,
      targetType: 'post' as const,
      postId: post.id,
      reason: 'spam' as const,
    };
    await testDb.db.insert(reports).values(values);
    await testDb.db
      .insert(reports)
      .values({ ...values, reason: 'hate' })
      .onConflictDoNothing();
    expect((await pgErrorOf(() => testDb.db.insert(reports).values(values)))?.code).toBe(
      PgErrorCode.UNIQUE_VIOLATION,
    );
    // Outra pessoa, ou a mesma pessoa denunciando a conta, são denúncias diferentes.
    await testDb.db.insert(reports).values({ ...values, reporterId: other.id });
    await testDb.db.insert(reports).values({ ...values, targetType: 'account', postId: null });
    expect(await testDb.db.select().from(reports)).toHaveLength(3);
  });

  it('post apagado de vez: a denúncia fica sem a referência; conta apagada de vez: a denúncia sai', async () => {
    const reporter = await createUser(testDb.db);
    const author = await createUser(testDb.db, { accountType: 'creator' });
    const post = await createPost(testDb.db, author);
    await testDb.db.insert(reports).values({
      reporterId: reporter.id,
      targetUserId: author.id,
      targetType: 'post',
      postId: post.id,
      reason: 'violence',
    });
    await testDb.db.delete(posts).where(eq(posts.id, post.id));
    const [kept] = await testDb.db.select().from(reports);
    expect(kept).toMatchObject({ targetType: 'post', postId: null, targetUserId: author.id });
    expect(await testDb.db.select().from(comments)).toHaveLength(0);

    await testDb.db.delete(users).where(eq(users.id, author.id));
    expect(await testDb.db.select().from(reports)).toHaveLength(0);
  });
});

describe('índice da busca de criadores (BUS-*)', () => {
  it('o LIKE por prefixo em collation "C" usa o índice parcial dos criadores ativos', async () => {
    await createUser(testDb.db, { handle: 'estudioaurora', accountType: 'creator' });
    await createUser(testDb.db, { handle: 'estudante' });
    await testDb.db.execute(sql`set enable_seqscan = off`);
    try {
      const result = await testDb.db.execute(sql`
          explain select handle from users
           where account_type = 'creator' and deleted_at is null
             and (handle collate "C") like 'estu%'
           order by (handle collate "C") limit 20`);
      const plan = (result as { rows: { 'QUERY PLAN': string }[] }).rows
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      expect(plan).toContain('users_creator_handle_prefix_idx');
    } finally {
      await testDb.db.execute(sql`set enable_seqscan = on`);
    }
  });
});
