import { describe, expect, it, vi } from 'vitest';

import {
  MemoryProximityStore,
  proximityKeys,
  RedisProximityStore,
  type ProximityTokenRecord,
  type ProximityTtls,
} from './proximity.store.js';
import { FakeClock } from '../../testing/fake-clock.js';

const TTLS: ProximityTtls = { validMs: 30_000, recentMs: 120_000, screenMs: 30_000 };
const RECORD: ProximityTokenRecord = { userId: 'u1', issuedAt: 1 };

/** O mapa de valores do fake, para gravar um registro em formato antigo ou ilegível. */
function rawValues(store: MemoryProximityStore) {
  return (store as unknown as { values: Map<string, { value: string; expiresAt: number }> }).values;
}

describe('MemoryProximityStore (validades sobre o Clock)', () => {
  it('[PROX-02] [PROX-03] válido até 30 s, recente até 120 s, tela aberta até 30 s', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    await store.issue('h1', RECORD, TTLS);
    expect(await store.findValid(['h1', 'outro'])).toEqual([RECORD, null]);
    expect(await store.isScreenOpen('u1')).toBe(true);

    clock.advance(29_999);
    expect(await store.findValid(['h1'])).toEqual([RECORD]);
    clock.advance(1);
    expect(await store.findValid(['h1'])).toEqual([null]);
    expect(await store.isScreenOpen('u1')).toBe(false);
    expect(await store.findRecent('h1')).toEqual(RECORD);

    clock.advance(90_000);
    expect(await store.findRecent('h1')).toBeNull();
  });

  it('[PROX-01] ADR 0013: o registro é só {uid, iat}, sem canal; o hash fica indexado na conta', async () => {
    const store = new MemoryProximityStore(new FakeClock());
    await store.issue('h1', RECORD, TTLS);
    await store.issue('h2', { userId: 'u1', issuedAt: 2 }, TTLS);
    expect(store.entries()).toContainEqual({
      key: proximityKeys.valid('h1'),
      value: '{"uid":"u1","iat":1}',
    });
    expect(store.entries()).toContainEqual({ key: proximityKeys.issued('u1'), value: 'h1,h2' });
  });

  it('[PROX-05] ADR 0013: registro da ADR 0012 com canal "ble" (anúncio Bluetooth) não vale; "qr" antigo vale', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const expiresAt = clock.now().getTime() + 30_000;
    rawValues(store).set(proximityKeys.valid('hb'), {
      value: '{"uid":"u1","iat":1,"ch":"ble"}',
      expiresAt,
    });
    rawValues(store).set(proximityKeys.valid('hq'), {
      value: '{"uid":"u1","iat":1,"ch":"qr"}',
      expiresAt,
    });
    rawValues(store).set(proximityKeys.valid('hx'), { value: 'não é json', expiresAt });
    expect(await store.findValid(['hb', 'hq', 'hx'])).toEqual([null, RECORD, null]);
  });

  it('[PROX-27] revokeUser apaga todos os tokens emitidos pela conta e a tela aberta', async () => {
    const store = new MemoryProximityStore(new FakeClock());
    const other: ProximityTokenRecord = { userId: 'u2', issuedAt: 1 };
    await store.issue('h1', RECORD, TTLS);
    await store.issue('h2', RECORD, TTLS);
    await store.issue('h3', other, TTLS);
    await store.revokeUser('u1');
    expect(await store.findValid(['h1', 'h2', 'h3'])).toEqual([null, null, other]);
    expect(await store.findRecent('h1')).toBeNull();
    expect(await store.findRecent('h2')).toBeNull();
    expect(await store.isScreenOpen('u1')).toBe(false);
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.issued('u1'));
  });

  it('contador de janela fixa e bloqueio com tempo restante', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    expect(await store.hit('k', 1_000)).toEqual({ count: 1, resetInMs: 1_000 });
    clock.advance(400);
    expect(await store.hit('k', 1_000)).toEqual({ count: 2, resetInMs: 600 });
    clock.advance(600);
    expect(await store.hit('k', 1_000)).toEqual({ count: 1, resetInMs: 1_000 });

    expect(await store.lockRemainingMs('u1')).toBe(0);
    await store.lock('u1', 900_000);
    clock.advance(100_000);
    expect(await store.lockRemainingMs('u1')).toBe(800_000);
    clock.advance(800_000);
    expect(await store.lockRemainingMs('u1')).toBe(0);
  });
});

describe('proximityKeys (arquitetura.md §6, ADR 0013)', () => {
  it('[PROX-43] só as chaves do token, da tela e do bloqueio: nada do encosto', () => {
    expect(Object.keys(proximityKeys).sort()).toEqual([
      'issued',
      'lock',
      'recent',
      'screen',
      'valid',
    ]);
    expect(proximityKeys.valid('h')).toBe('prox:t:h');
    expect(proximityKeys.recent('h')).toBe('prox:r:h');
    expect(proximityKeys.screen('u')).toBe('prox:u:u');
    expect(proximityKeys.issued('u')).toBe('prox:ut:u');
    expect(proximityKeys.lock('u')).toBe('prox:lock:u');
  });
});

describe('RedisProximityStore (comandos)', () => {
  function fakeRedis(execResult: [Error | null, unknown][] | null = []) {
    const calls: unknown[][] = [];
    const chain = {
      set: (...args: unknown[]) => (calls.push(['set', ...args]), chain),
      sadd: (...args: unknown[]) => (calls.push(['sadd', ...args]), chain),
      pexpire: (...args: unknown[]) => (calls.push(['pexpire', ...args]), chain),
      exec: () => Promise.resolve(execResult),
    };
    const redis = {
      multi: () => chain,
      mget: vi.fn((...keys: string[]) =>
        Promise.resolve(
          keys.map((key) => {
            if (key === 'prox:t:h1') return '{"uid":"u1","iat":7}';
            // Da ADR 0012: o `qr` ainda vale; o `ble` (anúncio) e canais desconhecidos, não.
            if (key === 'prox:t:hq') return '{"uid":"u1","iat":7,"ch":"qr"}';
            if (key === 'prox:t:hb') return '{"uid":"u1","iat":7,"ch":"ble"}';
            if (key === 'prox:t:nfc') return '{"uid":"u1","iat":7,"ch":"nfc"}';
            return null;
          }),
        ),
      ),
      get: vi.fn(() => Promise.resolve('não é json')),
      exists: vi.fn(() => Promise.resolve(1)),
      smembers: vi.fn(() => Promise.resolve(['h1', 'h2'])),
      del: vi.fn(() => Promise.resolve(6)),
      set: vi.fn(() => Promise.resolve('OK')),
      pttl: vi.fn(() => Promise.resolve(-2)),
      eval: vi.fn(() => Promise.resolve([3, 500])),
    };
    return { redis, calls };
  }

  it('[PROX-01] grava só o hash, sem canal, PX de 30/120/30 s, e indexa o hash na conta', async () => {
    const { redis, calls } = fakeRedis();
    await new RedisProximityStore(redis as never).issue('h1', RECORD, TTLS);
    expect(calls).toEqual([
      ['set', 'prox:t:h1', '{"uid":"u1","iat":1}', 'PX', 30_000],
      ['set', 'prox:r:h1', '{"uid":"u1","iat":1}', 'PX', 120_000],
      ['set', 'prox:u:u1', 'h1', 'PX', 30_000],
      ['sadd', 'prox:ut:u1', 'h1'],
      ['pexpire', 'prox:ut:u1', 120_000],
    ]);
  });

  it('MULTI com erro ou abortado lança (o service responde 503, fail-closed)', async () => {
    await expect(
      new RedisProximityStore(fakeRedis([[new Error('OOM'), null]]).redis as never).issue(
        'h1',
        RECORD,
        TTLS,
      ),
    ).rejects.toThrow('OOM');
    await expect(
      new RedisProximityStore(fakeRedis(null).redis as never).issue('h1', RECORD, TTLS),
    ).rejects.toThrow();
  });

  it('[PROX-31] leituras (registro antigo `ble` = inexistente), revogação, contador e bloqueio', async () => {
    const { redis } = fakeRedis();
    const store = new RedisProximityStore(redis as never);
    expect(await store.findValid(['h1', 'hq', 'hb', 'nfc', 'h9'])).toEqual([
      { userId: 'u1', issuedAt: 7 },
      { userId: 'u1', issuedAt: 7 },
      null,
      null,
      null,
    ]);
    expect(await store.findValid([])).toEqual([]);
    expect(await store.findRecent('h1')).toBeNull();
    expect(await store.isScreenOpen('u1')).toBe(true);
    await store.revokeUser('u1');
    expect(redis.del).toHaveBeenCalledWith(
      'prox:t:h1',
      'prox:r:h1',
      'prox:t:h2',
      'prox:r:h2',
      'prox:u:u1',
      'prox:ut:u1',
    );
    expect(await store.hit('rl:x', 1_000)).toEqual({ count: 3, resetInMs: 500 });
    await store.lock('u1', 900_000);
    expect(redis.set).toHaveBeenCalledWith('prox:lock:u1', '1', 'PX', 900_000);
    expect(await store.lockRemainingMs('u1')).toBe(0);
  });
});
