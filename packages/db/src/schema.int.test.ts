// Integração do schema: migrations reais, constraints e o trigger de tipo de conta (PERM-06).
// Roda contra o Postgres do compose (padrão) ou o PGlite (TEST_DB=pglite).
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findPgError, PgErrorCode } from './errors.ts';
import { emailTokens, refreshTokens, retiredHandles, users } from './schema/index.ts';
import { createTestDatabase, createUser, type TestDatabase } from './testing/index.ts';

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

/** Executa e devolve o erro do Postgres (SQLSTATE + constraint). */
async function pgErrorOf(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('era esperado um erro do banco');
}

describe('migrations', () => {
  it('sobem do zero e ficam registradas', async () => {
    const result = await testDb.db.execute(
      sql`select count(*)::int as total from drizzle.__drizzle_migrations`,
    );
    const rows = (result as { rows: { total: number }[] }).rows;
    expect(rows[0]?.total).toBeGreaterThanOrEqual(2);
  });

  it('o id padrão é um uuidv7 (ordenável no tempo)', async () => {
    const user = await createUser(testDb.db);
    expect(user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('users: tipo de conta (ADR 0008)', () => {
  it('[PERM-06] o trigger recusa UPDATE de account_type', async () => {
    const user = await createUser(testDb.db, { accountType: 'personal' });
    const error = await pgErrorOf(() =>
      testDb.db.update(users).set({ accountType: 'creator' }).where(eq(users.id, user.id)),
    );
    expect(error).toEqual({
      code: PgErrorCode.CHECK_VIOLATION,
      constraint: 'users_account_type_immutable',
    });
    const [row] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(row?.accountType).toBe('personal');
  });

  it('[PERM-06] UPDATE de outras colunas continua permitido', async () => {
    const user = await createUser(testDb.db, { accountType: 'creator' });
    await testDb.db.update(users).set({ name: 'Novo nome' }).where(eq(users.id, user.id));
    const [row] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ name: 'Novo nome', accountType: 'creator' });
  });

  it('[PERM-06] UNIQUE (id, account_type) existe para as FKs compostas', async () => {
    const result = await testDb.db.execute(
      sql`select conname from pg_constraint where conname = 'users_id_account_type_key'`,
    );
    expect((result as { rows: unknown[] }).rows).toHaveLength(1);
  });
});

describe('users: constraints', () => {
  it.each([
    ['e-mail com maiúscula', { email: 'Ana@x.com' }, 'users_email_lowercase_chk'],
    ['@ com maiúscula', { handle: 'Ana' }, 'users_handle_format_chk'],
    ['@ com 2 caracteres', { handle: 'ab' }, 'users_handle_format_chk'],
    ['@ só com pontos', { handle: '...' }, 'users_handle_format_chk'],
    ['nome vazio', { name: '' }, 'users_name_length_chk'],
    ['nome com 61 caracteres', { name: 'a'.repeat(61) }, 'users_name_length_chk'],
    ['bio com 151 caracteres', { bio: 'a'.repeat(151) }, 'users_bio_length_chk'],
  ])('recusa %s', async (_label, overrides, constraint) => {
    const error = await pgErrorOf(() => createUser(testDb.db, overrides));
    expect(error).toEqual({ code: PgErrorCode.CHECK_VIOLATION, constraint });
  });

  it('nome e bio contam code points (emoji = 1), como a regra do app', async () => {
    const user = await createUser(testDb.db, { name: '😀'.repeat(60), bio: '😀'.repeat(150) });
    expect(user.name).toBe('😀'.repeat(60));
  });

  it('@ é único para sempre, inclusive de conta excluída (A-14)', async () => {
    await createUser(testDb.db, { handle: 'helena', deletedAt: new Date() });
    const error = await pgErrorOf(() => createUser(testDb.db, { handle: 'helena' }));
    expect(error).toEqual({ code: PgErrorCode.UNIQUE_VIOLATION, constraint: 'users_handle_key' });
  });

  it('e-mail é único só entre contas ativas', async () => {
    await createUser(testDb.db, { email: 'ana@x.com' });
    const error = await pgErrorOf(() => createUser(testDb.db, { email: 'ana@x.com' }));
    expect(error).toEqual({
      code: PgErrorCode.UNIQUE_VIOLATION,
      constraint: 'users_email_active_key',
    });

    await testDb.db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.email, 'ana@x.com'));
    await expect(createUser(testDb.db, { email: 'ana@x.com' })).resolves.toMatchObject({
      email: 'ana@x.com',
    });
  });

  it('retired_handles só aceita minúsculas', async () => {
    const error = await pgErrorOf(() => testDb.db.insert(retiredHandles).values({ handle: 'Ana' }));
    expect(error?.code).toBe(PgErrorCode.CHECK_VIOLATION);
  });
});

describe('refresh_tokens e email_tokens', () => {
  it('apagar a conta (hard delete) apaga sessões e tokens em cascata', async () => {
    const user = await createUser(testDb.db);
    const now = new Date();
    await testDb.db.insert(refreshTokens).values({
      userId: user.id,
      familyId: user.id,
      tokenHash: new Uint8Array(32).fill(1),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await testDb.db.insert(emailTokens).values({
      userId: user.id,
      purpose: 'verify_email',
      email: user.email,
      tokenHash: new Uint8Array(32).fill(2),
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await testDb.db.delete(users).where(eq(users.id, user.id));

    expect(await testDb.db.select().from(refreshTokens)).toHaveLength(0);
    expect(await testDb.db.select().from(emailTokens)).toHaveLength(0);
  });

  it('o hash do token é único', async () => {
    const user = await createUser(testDb.db);
    const values = {
      userId: user.id,
      familyId: user.id,
      tokenHash: new Uint8Array(32).fill(7),
      expiresAt: new Date(Date.now() + 60_000),
    };
    await testDb.db.insert(refreshTokens).values(values);
    const error = await pgErrorOf(() => testDb.db.insert(refreshTokens).values(values));
    expect(error).toEqual({
      code: PgErrorCode.UNIQUE_VIOLATION,
      constraint: 'refresh_tokens_token_hash_key',
    });
  });

  it('FK para usuário inexistente é recusada', async () => {
    const error = await pgErrorOf(() =>
      testDb.db.insert(refreshTokens).values({
        userId: '01a189e0-af57-7000-85fe-2054e618fea6',
        familyId: '01a189e0-af57-7000-85fe-2054e618fea6',
        tokenHash: new Uint8Array(32).fill(3),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    expect(error?.code).toBe(PgErrorCode.FOREIGN_KEY_VIOLATION);
  });
});
