// Integração do schema da Fase 4 (pedidos de conexão, ADR 0003 e 0008), com as migrations reais,
// no Postgres do compose ou no PGlite (TEST_DB=pglite).
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findPgError, PgErrorCode } from './errors.ts';
import { connectionRequests, connections, users } from './schema/index.ts';
import { connect, createTestDatabase, createUser, type TestDatabase } from './testing/index.ts';

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

const NOW = new Date('2026-10-29T12:00:00.000Z');

async function pgErrorOf(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('era esperado um erro do banco');
}

function request(
  fromId: string,
  toId: string,
  overrides: Partial<typeof connectionRequests.$inferInsert> = {},
) {
  return testDb.db
    .insert(connectionRequests)
    .values({
      fromId,
      toId,
      method: 'qr',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 120_000),
      ...overrides,
    })
    .returning();
}

describe('connection_requests (ADR 0003 e 0008)', () => {
  it('[PERM-06] pedido com criador de qualquer lado é recusado pela FK composta; a si mesmo, pelo CHECK', async () => {
    const person = await createUser(testDb.db);
    const creator = await createUser(testDb.db, { accountType: 'creator' });
    expect((await pgErrorOf(() => request(person.id, creator.id)))?.code).toBe(
      PgErrorCode.FOREIGN_KEY_VIOLATION,
    );
    expect((await pgErrorOf(() => request(creator.id, person.id)))?.code).toBe(
      PgErrorCode.FOREIGN_KEY_VIOLATION,
    );
    expect(await pgErrorOf(() => request(person.id, person.id))).toEqual({
      code: PgErrorCode.CHECK_VIOLATION,
      constraint: 'connection_requests_not_self_chk',
    });
  });

  it('[PROX-13] [PROX-16] no máximo um pendente por par, em qualquer direção; encerrados não contam', async () => {
    const a = await createUser(testDb.db);
    const b = await createUser(testDb.db);
    const [first] = await request(a.id, b.id);
    for (const [from, to] of [
      [a.id, b.id],
      [b.id, a.id],
    ] as const) {
      expect(await pgErrorOf(() => request(from, to))).toEqual({
        code: PgErrorCode.UNIQUE_VIOLATION,
        constraint: 'connection_requests_pending_pair_key',
      });
    }
    await testDb.db
      .update(connectionRequests)
      .set({ status: 'declined', respondedAt: NOW })
      .where(eq(connectionRequests.id, first!.id));
    await request(b.id, a.id);
    expect(await testDb.db.select().from(connectionRequests)).toHaveLength(2);
  });

  it('responded_at existe só fora de pending; expires_at depois de created_at; método qr|nfc', async () => {
    const a = await createUser(testDb.db);
    const b = await createUser(testDb.db);
    expect(await pgErrorOf(() => request(a.id, b.id, { respondedAt: NOW }))).toEqual({
      code: PgErrorCode.CHECK_VIOLATION,
      constraint: 'connection_requests_responded_chk',
    });
    expect(await pgErrorOf(() => request(a.id, b.id, { status: 'accepted' }))).toEqual({
      code: PgErrorCode.CHECK_VIOLATION,
      constraint: 'connection_requests_responded_chk',
    });
    expect(await pgErrorOf(() => request(a.id, b.id, { expiresAt: NOW }))).toEqual({
      code: PgErrorCode.CHECK_VIOLATION,
      constraint: 'connection_requests_expiry_chk',
    });
    const [row] = await request(a.id, b.id, { method: 'nfc' });
    expect(row).toMatchObject({ status: 'pending', method: 'nfc', respondedAt: null });
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('o hard delete de uma conta apaga os pedidos em cascata; a conexão perde só o request_id quando o pedido sai', async () => {
    const a = await createUser(testDb.db);
    const b = await createUser(testDb.db);
    const c = await createUser(testDb.db);
    const [accepted] = await request(a.id, b.id, { status: 'accepted', respondedAt: NOW });
    await request(c.id, a.id);
    await connect(testDb.db, a, b);
    await testDb.db.update(connections).set({ requestId: accepted!.id });

    await testDb.db.delete(connectionRequests).where(eq(connectionRequests.id, accepted!.id));
    const [connection] = await testDb.db.select().from(connections);
    expect(connection?.requestId).toBeNull();

    await testDb.db.delete(users).where(eq(users.id, a.id));
    expect(await testDb.db.select().from(connectionRequests)).toEqual([]);
    expect(await testDb.db.select().from(connections)).toEqual([]);
  });
});
