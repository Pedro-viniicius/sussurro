// Testes que exigem Postgres e Valkey de verdade (compose ou CI). Pulados com TEST_DB=pglite:
// - o PGlite é uma conexão só, então não reproduz duas transações disputando a mesma linha;
// - sem Valkey, o script Lua do rate limit (atomicidade do INCR + PEXPIRE) não roda;
// - (Fase 3) sem Valkey, o cache de seguidores (MGET e SET PX) não roda; e só com várias conexões
//   um follow e um bloqueio do mesmo par disputam a trava de verdade;
// - (Fase 4) sem Valkey, o adaptador Redis dos tokens de proximidade (MULTI, MGET, PEXPIRE) não
//   roda (a suíte de proximidade usa o fake em memória nos dois modos, com o relógio de teste);
// - (ADR 0012) idem para o canal no registro do token, o script Lua do encosto (`TOUCH_SCRIPT`) e o
//   par encostado (`prox:m`);
// - (ADR 0012, Adendo A2 e revisão 1; PROX-56) idem para o `TOUCH_SCRIPT` com o prazo deslizante
//   (PX de 2 × janela em todo relato, sem `KEEPTTL`), o casamento (`CLAIM_TOUCH_SCRIPT`: janela,
//   ocupado, teto e cartão devido), a entrega única (`TAKE_OWED_CARD_SCRIPT`) e o sinal de abuso
//   (`BLOCK_SIGNAL_SCRIPT`: uma vez por casamento e por sentido, com `KEEPTTL` no par), com os
//   mesmos casos do fake (`proximity.store.spec.ts`).
import { follows, refreshTokens } from '@sussurro/db';
import { createUser, isPgliteMode } from '@sussurro/db/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RedisCounterCache } from '../../src/common/cache/counter-cache.js';
import { RedisRateLimitStore } from '../../src/common/rate-limit/rate-limit.store.js';
import {
  generateProximityToken,
  hashProximityToken,
  PROXIMITY_LIMITS,
} from '../../src/modules/proximity/proximity-token.js';
import {
  type ClaimTouchPairInput,
  type ProximityTokenRecord,
  proximityKeys,
  RedisProximityStore,
  TOUCH_SCRIPT,
  type TouchCard,
} from '../../src/modules/proximity/proximity.store.js';
import { directUser, loginViaApi } from '../support/auth.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/** (ADR 0012, A2-2) Janela do casamento (5 s do primeiro relato), ocupado (10 s) e par (60 s). */
const TOUCH_WINDOW_MS = 5_000;
const TOUCH_BUSY_MS = 10_000;
const TOUCH_PAIR_MS = 60_000;

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

  /** O cartão de quem chama, como o service monta (A2-2): `b` com foto, os outros sem. */
  function card(subjectId: string, atMs: number): TouchCard {
    return {
      subjectId,
      atMs,
      handle: `h.${subjectId}`,
      name: `Nome ${subjectId}`,
      avatarKey: subjectId === 'b' ? 'avatars/b.jpg' : null,
      connected: false,
    };
  }

  /** `callerId` casa com `otherId` (teto 10/h e 30/dia, o padrão do PO), pelo script do adaptador. */
  function claimAt(
    store: RedisProximityStore,
    callerId: string,
    otherId: string,
    atMs: number,
    overrides: Partial<ClaimTouchPairInput> = {},
  ) {
    return store.claimTouchPair({
      callerId,
      otherId,
      atMs,
      pairTtlMs: TOUCH_PAIR_MS,
      windowMs: TOUCH_WINDOW_MS,
      busyMs: TOUCH_BUSY_MS,
      perHour: 10,
      perDay: 30,
      callerCard: card(callerId, atMs),
      ...overrides,
    });
  }

  /** O prazo da chave no Valkey está em (`above`, `atMost`] ms. */
  async function expectTtl(key: string, above: number, atMost: number) {
    const ttl = await redis.pttl(key);
    expect(ttl, key).toBeGreaterThan(above);
    expect(ttl, key).toBeLessThanOrEqual(atMost);
  }

  it('[PROX-01] [PROX-02] [PROX-31] só o hash nas chaves, com o canal no registro, TTL de 30/120/30 s, PEXPIRE vence o token e o logout revoga', async () => {
    const store = new RedisProximityStore(redis);
    const token = generateProximityToken();
    const hash = hashProximityToken(token);
    const record: ProximityTokenRecord = { userId: 'u1', issuedAt: Date.now(), channel: 'qr' };
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
      ch: 'qr',
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

  it('[PROX-31] o canal volta na leitura; registro sem canal válido (anterior à ADR 0012) vale como inexistente', async () => {
    const store = new RedisProximityStore(redis);
    const ble = hashProximityToken(generateProximityToken());
    const record: ProximityTokenRecord = { userId: 'u1', issuedAt: Date.now(), channel: 'ble' };
    await store.issue(ble, record, { validMs: 30_000, recentMs: 120_000, screenMs: 30_000 });
    expect(await store.findValid([ble])).toEqual([record]);
    expect(await store.findRecent(ble)).toEqual(record);

    await redis.set('prox:t:legado', JSON.stringify({ uid: 'u1', iat: 1 }), 'PX', 30_000);
    await redis.set('prox:r:legado', JSON.stringify({ uid: 'u1', iat: 1, ch: 'x' }), 'PX', 30_000);
    expect(await store.findValid(['legado'])).toEqual([null]);
    expect(await store.findRecent('legado')).toBeNull();
  });

  it('[PROX-43] [PROX-48] [PROX-56] TOUCH_SCRIPT no Valkey (A2 rev. 1, R1-1): grava "{primeiroMs}:{hash}" com PX de 2 × janela; todo relato regrava com PX de 2 × janela desde agora (prazo deslizante, sem KEEPTTL), mantendo o primeiroMs e trocando o hash; depois de a chave vencer, o relato seguinte abre outra janela; casa com o primeiro relato do outro a 4,999 s e não a 5 s; formato antigo = não existe; o par fica na chave ordenada com PX de 60 s', async () => {
    const store = new RedisProximityStore(redis);
    const at = 1_000_000;
    const own = proximityKeys.touch('u1', 'u2');
    expect(await store.recordTouch('u1', 'u2', 'hash-1', at, TOUCH_WINDOW_MS)).toBe(false);
    expect(await redis.get(own)).toBe(`${String(at)}:hash-1`);
    await expectTtl(own, TOUCH_WINDOW_MS, 2 * TOUCH_WINDOW_MS);

    // Prazo deslizante: com o prazo quase no fim, o relato seguinte o renova (o KEEPTTL antigo o
    // manteria abaixo de 1 s)…
    await redis.pexpire(own, 1_000);
    expect(await store.recordTouch('u1', 'u2', 'hash-2', at + 4_000, TOUCH_WINDOW_MS)).toBe(false);
    expect(await redis.get(own)).toBe(`${String(at)}:hash-2`);
    await expectTtl(own, TOUCH_WINDOW_MS, 2 * TOUCH_WINDOW_MS);
    // …e com um prazo maior, volta a 2 × janela: é um SET … PX novo, não o KEEPTTL.
    await redis.pexpire(own, 60_000);
    expect(await store.recordTouch('u1', 'u2', 'hash-1', at + 4_500, TOUCH_WINDOW_MS)).toBe(false);
    expect(await redis.get(own)).toBe(`${String(at)}:hash-1`);
    await expectTtl(own, TOUCH_WINDOW_MS, 2 * TOUCH_WINDOW_MS);

    // A janela conta do primeiro relato de u1 (`at`), não do último (4,5 s).
    expect(
      await store.recordTouch('u2', 'u1', 'hash-3', at + TOUCH_WINDOW_MS - 1, TOUCH_WINDOW_MS),
    ).toBe(true);
    expect(
      await store.recordTouch('u2', 'u1', 'hash-3', at + TOUCH_WINDOW_MS, TOUCH_WINDOW_MS),
    ).toBe(false);

    // A observação de u2 vence (sem esperar 10 s): o relato seguinte de u1 já não é mútuo.
    await redis.pexpire(proximityKeys.touch('u2', 'u1'), 1);
    await expect.poll(() => redis.exists(proximityKeys.touch('u2', 'u1'))).toBe(0);
    expect(await store.recordTouch('u1', 'u2', 'hash-2', at + 4_800, TOUCH_WINDOW_MS)).toBe(false);
    expect(await redis.get(own)).toBe(`${String(at)}:hash-2`);

    // A chave de u1 vence (10 s sem relato): o relato seguinte abre outra janela, com outro
    // primeiroMs, e o relato de u2 dentro dela casa.
    await redis.pexpire(own, 1);
    await expect.poll(() => redis.exists(own)).toBe(0);
    const reopened = at + 30_000;
    expect(await store.recordTouch('u1', 'u2', 'hash-2', reopened, TOUCH_WINDOW_MS)).toBe(false);
    expect(await redis.get(own)).toBe(`${String(reopened)}:hash-2`);
    expect(
      await store.recordTouch(
        'u2',
        'u1',
        'hash-3',
        reopened + TOUCH_WINDOW_MS - 1,
        TOUCH_WINDOW_MS,
      ),
    ).toBe(true);

    // Valor de antes do A2 (só o horário): não existe (fecha) e é regravado no formato novo.
    await redis.set(proximityKeys.touch('u3', 'u4'), String(at), 'PX', 60_000);
    expect(await store.recordTouch('u4', 'u3', 'hash-4', at, TOUCH_WINDOW_MS)).toBe(false);
    expect(await store.recordTouch('u3', 'u4', 'hash-5', at + 1, TOUCH_WINDOW_MS)).toBe(true);
    expect(await redis.get(proximityKeys.touch('u3', 'u4'))).toBe(`${String(at + 1)}:hash-5`);
    await expectTtl(proximityKeys.touch('u3', 'u4'), TOUCH_WINDOW_MS, 2 * TOUCH_WINDOW_MS);

    await store.markTouchPair('u2', 'u1', 60_000, at);
    expect(await redis.keys('prox:m:*')).toEqual(['prox:m:u1:u2']);
    expect(await redis.get('prox:m:u1:u2')).toBe(String(at));
    const pairTtl = await redis.pttl('prox:m:u1:u2');
    expect(pairTtl).toBeGreaterThan(10_000);
    expect(pairTtl).toBeLessThanOrEqual(60_000);
    expect(await store.hasTouchPair('u1', 'u2')).toBe(true);
    expect(await store.hasTouchPair('u2', 'u1')).toBe(true);
    expect(await store.hasTouchPair('u1', 'u3')).toBe(false);
    await redis.pexpire('prox:m:u1:u2', 1);
    await expect.poll(() => store.hasTouchPair('u1', 'u2')).toBe(false);
  });

  it('[PROX-32] [PROX-56] 50 rodadas de relatos simultâneos A→B ∥ B→A: exatamente um vê a observação do outro na janela (o script grava e confere numa operação só)', async () => {
    const store = new RedisProximityStore(redis);
    for (let round = 0; round < 50; round++) {
      await redis.flushdb();
      const results = await Promise.all([
        store.recordTouch('a', 'b', 'hash-b', round, TOUCH_WINDOW_MS),
        store.recordTouch('b', 'a', 'hash-a', round, TOUCH_WINDOW_MS),
      ]);
      expect(results.filter(Boolean), `rodada ${String(round)}`).toHaveLength(1);
    }
    // O mesmo script que o adaptador manda ao Valkey (EVAL com 2 chaves e 3 argumentos).
    await redis.flushdb();
    expect(
      await redis.eval(TOUCH_SCRIPT, 2, 'prox:o:x:y', 'prox:o:y:x', '1', '5000', 'hash-y'),
    ).toBe(0);
    expect(
      await redis.eval(TOUCH_SCRIPT, 2, 'prox:o:y:x', 'prox:o:x:y', '2', '5000', 'hash-x'),
    ).toBe(1);
    expect(await redis.get('prox:o:x:y')).toBe('1:hash-y');
  });

  it('[PROX-45] [PROX-49] [PROX-53] [PROX-56] CLAIM_TOUCH_SCRIPT no Valkey: gone sem a observação ou fora da janela; created grava o par, o cartão devido ao outro (com o hash da observação), o ocupado de quem chama e soma 1 nos quatro contadores (PEXPIRE de 1 h e 24 h); busy e capped não gravam nem somam; renewed não soma', async () => {
    const store = new RedisProximityStore(redis);
    const at = 2_000_000;
    const keys = async () => (await redis.keys('*')).sort();

    // Sem a observação do outro, ou com o primeiro relato a 5 s: gone, sem gravar nada.
    expect(await claimAt(store, 'b', 'a', at)).toBe('gone');
    expect(await keys()).toEqual([]);
    await store.recordTouch('a', 'b', 'hash-de-b', at, TOUCH_WINDOW_MS);
    expect(await claimAt(store, 'b', 'a', at + TOUCH_WINDOW_MS)).toBe('gone');
    expect(await keys()).toEqual([proximityKeys.touch('a', 'b')]);

    // 4,999 s: casa.
    const matched = at + TOUCH_WINDOW_MS - 1;
    expect(await claimAt(store, 'b', 'a', matched)).toBe('created');
    expect(await redis.get(proximityKeys.pair('a', 'b'))).toBe(String(matched));
    expect(await redis.get(proximityKeys.owed('a'))).toBe(
      `hash-de-b|{"s":"b","at":${String(matched)},"h":"h.b","n":"Nome b","a":"avatars/b.jpg","c":false}`,
    );
    expect(await redis.get(proximityKeys.busy('b'))).toBe('1');
    expect(await redis.exists(proximityKeys.owed('b'), proximityKeys.busy('a'))).toBe(0);
    await expectTtl(proximityKeys.pair('a', 'b'), TOUCH_BUSY_MS, TOUCH_PAIR_MS);
    await expectTtl(proximityKeys.owed('a'), TOUCH_BUSY_MS, TOUCH_PAIR_MS);
    await expectTtl(proximityKeys.busy('b'), 0, TOUCH_BUSY_MS);
    for (const who of ['a', 'b']) {
      expect(await redis.get(proximityKeys.pairsPerHour(who))).toBe('1');
      expect(await redis.get(proximityKeys.pairsPerDay(who))).toBe('1');
      await expectTtl(proximityKeys.pairsPerHour(who), TOUCH_PAIR_MS, 3_600_000);
      await expectTtl(proximityKeys.pairsPerDay(who), 3_600_000, 86_400_000);
    }

    // Ocupado: a tem um cartão a receber e b está ocupado; x não casa com nenhum, nos dois
    // sentidos, e nada muda (nem o cartão devido a a, nem os contadores).
    const before = await redis.get(proximityKeys.owed('a'));
    for (const [caller, other] of [
      ['x', 'a'],
      ['a', 'x'],
      ['x', 'b'],
      ['b', 'x'],
    ] as const) {
      await store.recordTouch(other, caller, `hash-de-${caller}`, matched, TOUCH_WINDOW_MS);
      expect(await claimAt(store, caller, other, matched), `${caller} → ${other}`).toBe('busy');
    }
    expect(await redis.get(proximityKeys.owed('a'))).toBe(before);
    expect(await redis.exists(proximityKeys.pair('a', 'x'), proximityKeys.pair('b', 'x'))).toBe(0);
    expect(await redis.exists(proximityKeys.owed('x'), proximityKeys.busy('x'))).toBe(0);
    expect(await redis.exists(proximityKeys.pairsPerHour('x'))).toBe(0);

    // Renovação (o par a–b vive): sem ocupado, casa de novo sem somar.
    await redis.del(proximityKeys.owed('a'), proximityKeys.busy('b'));
    expect(await claimAt(store, 'b', 'a', matched)).toBe('renewed');
    expect(await redis.get(proximityKeys.pairsPerHour('a'))).toBe('1');
    expect(await redis.get(proximityKeys.pairsPerDay('b'))).toBe('1');

    // Teto (1/h para o teste): b já tem 1 par novo na hora. Par novo b–c, nos dois sentidos →
    // capped, sem par, sem cartão, sem ocupado e sem somar (nem para c).
    await redis.del(proximityKeys.owed('a'), proximityKeys.busy('b'));
    for (const [caller, other] of [
      ['c', 'b'],
      ['b', 'c'],
    ] as const) {
      await store.recordTouch(other, caller, `hash-de-${caller}`, matched, TOUCH_WINDOW_MS);
      expect(await claimAt(store, caller, other, matched + 2, { perHour: 1, perDay: 30 })).toBe(
        'capped',
      );
    }
    expect(await redis.exists(proximityKeys.pair('b', 'c'))).toBe(0);
    expect(
      await redis.exists(
        proximityKeys.owed('b'),
        proximityKeys.owed('c'),
        proximityKeys.busy('b'),
        proximityKeys.busy('c'),
        proximityKeys.pairsPerHour('c'),
        proximityKeys.pairsPerDay('c'),
      ),
    ).toBe(0);
    expect(await redis.get(proximityKeys.pairsPerHour('b'))).toBe('1');
    expect(await redis.get(proximityKeys.pairsPerDay('b'))).toBe('1');
    // O teto do dia também barra (1/dia), e a resposta fora das cinco nunca aparece.
    expect(await claimAt(store, 'c', 'b', matched + 3, { perHour: 30, perDay: 1 })).toBe('capped');
    expect(await claimAt(store, 'c', 'b', matched + 4, { perHour: 30, perDay: 30 })).toBe(
      'created',
    );
  });

  it('[PROX-49] [PROX-56] TAKE_OWED_CARD_SCRIPT no Valkey: entrega única (GET, DEL) e a conta fica ocupada (PX); sem cartão → null sem gravar nada; ilegível → null e apagado', async () => {
    const store = new RedisProximityStore(redis);
    const at = 3_000_000;
    expect(await store.takeOwedCard('a', TOUCH_BUSY_MS)).toBeNull();
    expect(await redis.keys('*')).toEqual([]);

    await store.recordTouch('a', 'b', 'hash-de-b', at, TOUCH_WINDOW_MS);
    expect(await claimAt(store, 'b', 'a', at)).toBe('created');
    expect(await store.takeOwedCard('a', TOUCH_BUSY_MS)).toEqual({
      tokenHash: 'hash-de-b',
      subjectId: 'b',
      atMs: at,
      handle: 'h.b',
      name: 'Nome b',
      avatarKey: 'avatars/b.jpg',
      connected: false,
    });
    expect(await redis.exists(proximityKeys.owed('a'))).toBe(0);
    expect(await redis.get(proximityKeys.busy('a'))).toBe('1');
    await expectTtl(proximityKeys.busy('a'), 0, TOUCH_BUSY_MS);
    expect(await store.takeOwedCard('a', TOUCH_BUSY_MS)).toBeNull();

    for (const value of ['sem-separador', '|{"s":"b"}', 'h|não é json', 'h|{"s":"b","at":1}']) {
      await redis.set(proximityKeys.owed('c'), value, 'PX', TOUCH_PAIR_MS);
      expect(await store.takeOwedCard('c', TOUCH_BUSY_MS), value).toBeNull();
      expect(await redis.exists(proximityKeys.owed('c'))).toBe(0);
    }

    // forgetTouchState (só dev): apaga o cartão devido e o ocupado, e nada mais.
    await store.forgetTouchState('a');
    await store.forgetTouchState('c');
    expect(await redis.exists(proximityKeys.busy('a'), proximityKeys.busy('c'))).toBe(0);
    expect(await redis.exists(proximityKeys.pair('a', 'b'))).toBe(1);
  });

  it('[PROX-54] [PROX-56] 50 rodadas de casamentos simultâneos do mesmo par no Valkey: um created e um busy; nunca dois pares nem dois cartões devidos; cada conta soma 1', async () => {
    const store = new RedisProximityStore(redis);
    for (let round = 0; round < 50; round++) {
      await redis.flushdb();
      const at = 4_000_000 + round;
      await store.recordTouch('a', 'b', 'hash-de-b', at, TOUCH_WINDOW_MS);
      await store.recordTouch('b', 'a', 'hash-de-a', at, TOUCH_WINDOW_MS);
      const outcomes = await Promise.all([
        claimAt(store, 'a', 'b', at),
        claimAt(store, 'b', 'a', at),
      ]);
      expect([...outcomes].sort(), `rodada ${String(round)}`).toEqual(['busy', 'created']);
      expect((await redis.keys('prox:v:*')).length).toBe(1);
      expect(await redis.get(proximityKeys.pairsPerHour('a'))).toBe('1');
      expect(await redis.get(proximityKeys.pairsPerHour('b'))).toBe('1');
    }
  });

  it('[PROX-55] [PROX-56] [PROX-63] BLOCK_SIGNAL_SCRIPT no Valkey (A2 rev. 1, R1-6): sem par → null sem gravar nada; com o par, marca o sentido no valor do par mantendo o prazo (KEEPTTL) e soma 1 nos dois contadores (PEXPIRE de 7 dias); o mesmo sentido não conta de novo no mesmo casamento; o outro sentido conta uma vez ("ab" ou "ba"); a renovação do par limpa as marcas; valor ilegível → null; 5 contagens simultâneas → uma só', async () => {
    const store = new RedisProximityStore(redis);
    const week = PROXIMITY_LIMITS.blockAfterTouch.windowMs;
    const at = 5_000_000;
    const pair = proximityKeys.pair('a', 'b');
    const blocker = (userId: string) => proximityKeys.blockSignal('blocker', userId);
    const blocked = (userId: string) => proximityKeys.blockSignal('blocked', userId);

    // Sem par: nada conta e nada é gravado.
    expect(await store.countBlockSignal('a', 'b', week)).toBeNull();
    expect(await redis.keys('*')).toEqual([]);

    // a (o menor id) bloqueia b: sentido "a", e o prazo do par não muda (KEEPTTL).
    await store.markTouchPair('a', 'b', TOUCH_PAIR_MS, at);
    await redis.pexpire(pair, 30_000);
    expect(await store.countBlockSignal('a', 'b', week)).toEqual({ blocker: 1, blocked: 1 });
    expect(await redis.get(pair)).toBe(`${String(at)}:a`);
    await expectTtl(pair, 20_000, 30_000);
    expect(await redis.get(blocker('a'))).toBe('1');
    expect(await redis.get(blocked('b'))).toBe('1');
    await expectTtl(blocker('a'), week - 60_000, week);
    await expectTtl(blocked('b'), week - 60_000, week);
    expect(await redis.exists(blocked('a'), blocker('b'))).toBe(0);
    expect(await store.hasTouchPair('a', 'b')).toBe(true);

    // De novo no mesmo casamento (bloquear, desbloquear e bloquear, ou bloqueios em paralelo): nada.
    expect(await store.countBlockSignal('a', 'b', week)).toBeNull();
    expect(await redis.get(blocker('a'))).toBe('1');
    expect(await redis.get(pair)).toBe(`${String(at)}:a`);

    // b bloqueia a: o sentido "b" conta uma vez, e o par continua com o mesmo prazo.
    expect(await store.countBlockSignal('b', 'a', week)).toEqual({ blocker: 1, blocked: 1 });
    expect(await redis.get(pair)).toBe(`${String(at)}:ab`);
    expect(await store.countBlockSignal('b', 'a', week)).toBeNull();
    expect(await store.countBlockSignal('a', 'b', week)).toBeNull();
    await expectTtl(pair, 20_000, 30_000);

    // A ordem contrária grava "ba".
    await store.markTouchPair('c', 'd', TOUCH_PAIR_MS, at);
    expect(await store.countBlockSignal('d', 'c', week)).toEqual({ blocker: 1, blocked: 1 });
    expect(await store.countBlockSignal('c', 'd', week)).toEqual({ blocker: 1, blocked: 1 });
    expect(await redis.get(proximityKeys.pair('c', 'd'))).toBe(`${String(at)}:ba`);

    // A renovação do par (o casamento regrava só o horário) limpa as marcas: conta de novo.
    const renewedAt = at + 20_000;
    await store.recordTouch('a', 'b', 'hash-de-b', renewedAt, TOUCH_WINDOW_MS);
    expect(await claimAt(store, 'b', 'a', renewedAt)).toBe('renewed');
    expect(await redis.get(pair)).toBe(String(renewedAt));
    expect(await store.countBlockSignal('a', 'b', week)).toEqual({ blocker: 2, blocked: 2 });
    expect(await redis.get(pair)).toBe(`${String(renewedAt)}:a`);

    // Contador sem prazo (PTTL < 0) ganha o PEXPIRE de novo.
    await redis.set(blocker('i'), '5');
    await store.markTouchPair('i', 'j', TOUCH_PAIR_MS, at);
    expect(await store.countBlockSignal('i', 'j', week)).toEqual({ blocker: 6, blocked: 1 });
    await expectTtl(blocker('i'), week - 60_000, week);

    // Valor ilegível: não conta nem muda nada.
    await redis.set(proximityKeys.pair('e', 'f'), 'lixo', 'PX', TOUCH_PAIR_MS);
    expect(await store.countBlockSignal('e', 'f', week)).toBeNull();
    expect(await redis.get(proximityKeys.pair('e', 'f'))).toBe('lixo');
    expect(await redis.exists(blocker('e'), blocked('f'))).toBe(0);

    // 5 contagens simultâneas do mesmo sentido (N bloqueios em paralelo): o script serializa.
    await store.markTouchPair('g', 'h', TOUCH_PAIR_MS, at);
    const counts = await Promise.all(
      Array.from({ length: 5 }, () => store.countBlockSignal('h', 'g', week)),
    );
    expect(counts.filter((count) => count !== null)).toEqual([{ blocker: 1, blocked: 1 }]);
    expect(await redis.get(blocker('h'))).toBe('1');
    expect(await redis.get(blocked('g'))).toBe('1');
    expect(await redis.get(proximityKeys.pair('g', 'h'))).toBe(`${String(at)}:b`);
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
