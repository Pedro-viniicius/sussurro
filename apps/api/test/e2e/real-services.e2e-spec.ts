// Testes que exigem Postgres e Valkey de verdade (compose ou CI). Pulados com TEST_DB=pglite:
// - o PGlite é uma conexão só, então não reproduz duas transações disputando a mesma linha;
// - sem Valkey, o script Lua do rate limit (atomicidade do INCR + PEXPIRE) não roda;
// - (Fase 3) sem Valkey, o cache de seguidores (MGET e SET PX) não roda; e só com várias conexões
//   um follow e um bloqueio do mesmo par disputam a trava de verdade;
// - (Fase 4) sem Valkey, o adaptador Redis dos tokens de proximidade (MULTI, MGET, PEXPIRE) não
//   roda (a suíte de proximidade usa o fake em memória nos dois modos, com o relógio de teste);
// - (ADR 0013) o registro do token sem canal, e o registro antigo `ble` da ADR 0012 tratado como
//   inexistente;
// - (Fase 6; NOT-10) só com várias conexões os follows de pessoas diferentes ao mesmo criador
//   disputam a linha do dia da notificação de seguidores (o `INSERT … ON CONFLICT DO UPDATE` do
//   `upsertFollowers`). A trava do par não os serializa: cada par tem a sua.
import { eq, follows, notifications, refreshTokens, sql, type Transaction } from '@sussurro/db';
import { createUser, isPgliteMode } from '@sussurro/db/testing';
import { followersBucketKey } from '@sussurro/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RedisCounterCache } from '../../src/common/cache/counter-cache.js';
import { rowsOf } from '../../src/common/db/rows.js';
import { RedisRateLimitStore } from '../../src/common/rate-limit/rate-limit.store.js';
import {
  generateProximityToken,
  hashProximityToken,
} from '../../src/modules/proximity/proximity-token.js';
import {
  type ProximityTokenRecord,
  RedisProximityStore,
} from '../../src/modules/proximity/proximity.store.js';
import { directUser, loginViaApi } from '../support/auth.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

describe.skipIf(isPgliteMode())('refresh concorrente (Postgres real)', () => {
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

  it('[AUTH-08] duas rotações simultâneas do mesmo refresh: serializadas pelo FOR UPDATE, uma família só com um token ativo', async () => {
    const user = await createUser(t.database.db);
    const { tokens } = await loginViaApi(t.http, user.email);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.http.post('/v1/auth/refresh').send({ refreshToken: tokens.refreshToken }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);

    const rows = await t.database.db.select().from(refreshTokens);
    const active = rows.filter((row) => row.usedAt === null && row.revokedAt === null);
    expect(active).toHaveLength(1);
    expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
  });
});

describe.skipIf(isPgliteMode())('rate limit no Valkey (script Lua)', () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    db: 15,
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('[AUTH-07] INCR + PEXPIRE atômicos: 50 acessos simultâneos contam 50 e a chave expira', async () => {
    const store = new RedisRateLimitStore(redis);
    const hits = await Promise.all(Array.from({ length: 50 }, () => store.hit('rl:teste', 1_000)));
    expect(Math.max(...hits.map((hit) => hit.count))).toBe(50);
    expect(new Set(hits.map((hit) => hit.count)).size).toBe(50);
    const ttl = await redis.pttl('rl:teste');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1_000);
  });
});

describe.skipIf(isPgliteMode())('cache de seguidores no Valkey (CNT-02)', () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    db: 15,
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('[CNT-02] MGET devolve o que o SET PX gravou, na ordem, e a chave vence no TTL', async () => {
    const cache = new RedisCounterCache(redis);
    await cache.setMany(
      [
        { key: 'cnt:followers:a', value: 12 },
        { key: 'cnt:followers:b', value: 0 },
      ],
      1_000,
    );
    await expect(
      cache.getMany(['cnt:followers:b', 'cnt:followers:x', 'cnt:followers:a']),
    ).resolves.toEqual([0, null, 12]);
    const ttl = await redis.pttl('cnt:followers:a');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1_000);
  });
});

describe.skipIf(isPgliteMode())('seguir e bloquear ao mesmo tempo (Postgres real, X.2)', () => {
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

  it('[X.2] follow e bloqueio do mesmo par em paralelo: a trava do par garante que nenhum follow sobrevive ao bloqueio', async () => {
    for (let round = 0; round < 10; round++) {
      await t.reset();
      const creator = await directUser(t.app, t.database.db, {
        handle: 'criadora',
        accountType: 'creator',
      });
      const fan = await directUser(t.app, t.database.db, { handle: 'fa_da_bia' });
      await Promise.all([
        t.http.put('/v1/creators/criadora/follow').set(fan.headers),
        t.http.post('/v1/me/blocks').set(fan.headers).send({ handle: 'criadora' }),
      ]);
      expect(await t.database.db.select().from(follows)).toHaveLength(0);
      expect(creator.user.handle).toBe('criadora');
    }
  });
});

describe.skipIf(isPgliteMode())('seguidores do dia em paralelo (Postgres real, NOT-10)', () => {
  /**
   * Follows que chegam juntos. Abaixo do pool de 10 do banco de teste: cada follow segura uma
   * conexão (a transação dele) e o teste usa mais duas (a barreira e a consulta ao
   * `pg_stat_activity`). Com o pool cheio, o `connectionTimeoutMillis` de 1 s viraria 500.
   */
  const FANS = 6;
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

  /** Conexões deste banco de teste paradas numa trava (a barreira é a única que as prende). */
  async function waitingOnLock(): Promise<number> {
    const result = await t.database.db.execute(sql`
      select count(*)::int as waiting
        from pg_stat_activity
       where datname = current_database()
         and backend_type = 'client backend'
         and wait_event_type = 'Lock'`);
    return rowsOf<{ waiting: number }>(result)[0]?.waiting ?? 0;
  }

  async function creatorAndFans() {
    const creator = await directUser(t.app, t.database.db, { accountType: 'creator' });
    const fans: { headers: Record<string, string> }[] = [];
    for (let index = 0; index < FANS; index++) {
      fans.push(await directUser(t.app, t.database.db));
    }
    return { creator, fans };
  }

  /**
   * Os follows soltos juntos sobre a mesma linha do dia, sem depender da sorte: uma transação do
   * teste (a barreira) segura a linha com `hold`; cada follow corre na transação dele, numa
   * conexão própria do pool, e para no upsert esperando a barreira. Quando o `pg_stat_activity`
   * mostra os `FANS` parados numa trava, a barreira é desfeita (ROLLBACK, nada fica) e todos
   * disputam a linha ao mesmo tempo.
   */
  async function followTogether(
    handle: string,
    fans: readonly { headers: Record<string, string> }[],
    hold: (tx: Transaction) => Promise<unknown>,
  ) {
    const release = new Error('barreira desfeita de propósito (ROLLBACK)');
    const held = Promise.withResolvers<undefined>();
    const barrier = t.database.db.transaction(async (tx) => {
      await hold(tx);
      held.resolve(undefined);
      await expect
        .poll(waitingOnLock, {
          timeout: 10_000,
          interval: 25,
          message: `os ${String(fans.length)} follows parados no upsert, cada um na sua conexão`,
        })
        .toBe(fans.length);
      throw release;
    });
    await Promise.race([held.promise, barrier]);
    const requests = Promise.all(
      fans.map((fan) => t.http.put(`/v1/creators/${handle}/follow`).set(fan.headers)),
    );
    const [barrierOutcome, responses] = await Promise.allSettled([barrier, requests]);
    if (barrierOutcome.status === 'fulfilled') {
      throw new Error('a barreira terminou sem ROLLBACK');
    }
    if (barrierOutcome.reason !== release) {
      throw barrierOutcome.reason;
    }
    if (responses.status === 'rejected') {
      throw responses.reason;
    }
    return responses.value.map((response) => response.status);
  }

  it('[NOT-10] [NOT-01] 6 follows ao mesmo criador, presos na linha do dia ainda não gravada e soltos juntos, cada um na sua conexão do pool: todos 200, 1 linha com count 6 e actor_id nulo, nenhum erro de unicidade e 1 push só', async () => {
    const { creator, fans } = await creatorAndFans();
    const now = t.clock.now();
    const bucketKey = followersBucketKey(now);

    const statuses = await followTogether(creator.user.handle, fans, (tx) =>
      tx.insert(notifications).values({
        recipientId: creator.user.id,
        type: 'new_followers',
        bucketKey,
        createdAt: now,
        updatedAt: now,
      }),
    );

    // Um 23505 (unicidade) no upsert viraria 500 e desfaria o follow.
    expect(statuses).toEqual(Array.from({ length: FANS }, () => 200));
    expect(await t.database.db.select().from(follows)).toHaveLength(FANS);
    const rows = await t.database.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientId: creator.user.id,
      type: 'new_followers',
      bucketKey,
      count: FANS,
      actorId: null,
      readAt: null,
    });
    // `becameUnread` só para quem criou a linha: os outros a encontram não lida.
    expect(t.push.sent).toEqual([{ type: 'notification', notificationId: rows[0]!.id }]);
  });

  it('[NOT-10] [NOT-06] linha do dia já lida (count 2), 6 follows presos nela e soltos juntos: count 8, volta a não lida e 1 push só (o de quem a reabriu)', async () => {
    const { creator, fans } = await creatorAndFans();
    const now = t.clock.now();
    const bucketKey = followersBucketKey(now);
    const [existing] = await t.database.db
      .insert(notifications)
      .values({
        recipientId: creator.user.id,
        type: 'new_followers',
        count: 2,
        bucketKey,
        readAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: notifications.id });

    const statuses = await followTogether(creator.user.handle, fans, (tx) =>
      tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.id, existing!.id))
        .for('update'),
    );

    expect(statuses).toEqual(Array.from({ length: FANS }, () => 200));
    const rows = await t.database.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: existing!.id, count: 2 + FANS, readAt: null });
    expect(t.push.sent).toEqual([{ type: 'notification', notificationId: existing!.id }]);
  });
});

describe.skipIf(isPgliteMode())('tokens de proximidade no Valkey (Fase 4, ADR 0003)', () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    db: 15,
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('[PROX-01] [PROX-02] [PROX-31] só o hash nas chaves, sem canal no registro (ADR 0013), TTL de 30/120/30 s, PEXPIRE vence o token e o logout revoga', async () => {
    const store = new RedisProximityStore(redis);
    const token = generateProximityToken();
    const hash = hashProximityToken(token);
    const record: ProximityTokenRecord = { userId: 'u1', issuedAt: Date.now() };
    await store.issue(hash, record, { validMs: 30_000, recentMs: 120_000, screenMs: 30_000 });

    const keys = await redis.keys('*');
    expect(keys.sort()).toEqual(
      [`prox:r:${hash}`, `prox:t:${hash}`, 'prox:u:u1', 'prox:ut:u1'].sort(),
    );
    for (const key of keys) {
      expect(key).not.toContain(token);
      const value = key === 'prox:ut:u1' ? await redis.smembers(key) : await redis.get(key);
      expect(JSON.stringify(value)).not.toContain(token);
    }
    expect(await redis.pttl(`prox:t:${hash}`)).toBeLessThanOrEqual(30_000);
    expect(await redis.pttl(`prox:r:${hash}`)).toBeGreaterThan(30_000);
    expect(JSON.parse((await redis.get(`prox:t:${hash}`))!)).toEqual({
      uid: 'u1',
      iat: record.issuedAt,
    });
    expect(await store.findValid([hash])).toEqual([record]);
    expect(await store.isScreenOpen('u1')).toBe(true);

    // Sem esperar 30 s: força a expiração do "válido" (testes.md §3.3).
    await redis.pexpire(`prox:t:${hash}`, 1);
    await redis.pexpire('prox:u:u1', 1);
    await expect.poll(() => store.findValid([hash])).toEqual([null]);
    expect(await store.findRecent(hash)).toEqual(record);

    await store.revokeUser('u1');
    expect(await store.findRecent(hash)).toBeNull();
    expect(await redis.keys('prox:*')).toEqual([]);
  });

  it('[PROX-31] registro antigo da ADR 0012: `qr` vale; `ble` (o anúncio) e canal desconhecido valem como inexistente', async () => {
    const store = new RedisProximityStore(redis);
    await redis.set('prox:t:qr', JSON.stringify({ uid: 'u1', iat: 1, ch: 'qr' }), 'PX', 30_000);
    await redis.set('prox:t:ble', JSON.stringify({ uid: 'u1', iat: 1, ch: 'ble' }), 'PX', 30_000);
    await redis.set('prox:r:x', JSON.stringify({ uid: 'u1', iat: 1, ch: 'x' }), 'PX', 30_000);
    expect(await store.findValid(['qr', 'ble'])).toEqual([{ userId: 'u1', issuedAt: 1 }, null]);
    expect(await store.findRecent('x')).toBeNull();
  });

  it('[PROX-20] contador (script Lua) e bloqueio com TTL', async () => {
    const store = new RedisProximityStore(redis);
    expect((await store.hit('rl:prox-failures:user:u1', 1_000)).count).toBe(1);
    expect((await store.hit('rl:prox-failures:user:u1', 1_000)).count).toBe(2);
    await store.lock('u1', 5_000);
    const remaining = await store.lockRemainingMs('u1');
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5_000);
    expect(await store.lockRemainingMs('u2')).toBe(0);
  });
});
