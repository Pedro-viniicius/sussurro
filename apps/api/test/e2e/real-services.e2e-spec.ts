// Testes que exigem Postgres e Valkey de verdade (compose ou CI). Pulados com TEST_DB=pglite:
// - o PGlite é uma conexão só, então não reproduz duas transações disputando a mesma linha;
// - sem Valkey, o script Lua do rate limit (atomicidade do INCR + PEXPIRE) não roda;
// - (Fase 3) sem Valkey, o cache de seguidores (MGET e SET PX) não roda; e só com várias conexões
//   um follow e um bloqueio do mesmo par disputam a trava de verdade;
// - (Fase 4) sem Valkey, o adaptador Redis dos tokens de proximidade (MULTI, MGET, PEXPIRE) não
//   roda (a suíte de proximidade usa o fake em memória nos dois modos, com o relógio de teste).
import { follows, refreshTokens } from '@sussurro/db';
import { createUser, isPgliteMode } from '@sussurro/db/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RedisCounterCache } from '../../src/common/cache/counter-cache.js';
import { RedisRateLimitStore } from '../../src/common/rate-limit/rate-limit.store.js';
import {
  generateProximityToken,
  hashProximityToken,
} from '../../src/modules/proximity/proximity-token.js';
import { RedisProximityStore } from '../../src/modules/proximity/proximity.store.js';
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

  it('[PROX-01] [PROX-02] só o hash nas chaves, TTL de 30/120/30 s, PEXPIRE vence o token e o logout revoga', async () => {
    const store = new RedisProximityStore(redis);
    const token = generateProximityToken();
    const hash = hashProximityToken(token);
    const record = { userId: 'u1', issuedAt: Date.now() };
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
