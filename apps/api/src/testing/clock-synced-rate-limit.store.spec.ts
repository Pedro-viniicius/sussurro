import { describe, expect, it } from 'vitest';

import { ClockSyncedRateLimitStore } from './clock-synced-rate-limit.store.js';
import { FakeClock } from './fake-clock.js';
import { WallClockRedis } from './wall-clock-redis.js';
import { DomainError } from '../common/errors/domain-error.js';
import { RedisRateLimitStore } from '../common/rate-limit/rate-limit.store.js';
import { RateLimiterService } from '../common/rate-limit/rate-limiter.service.js';

const MINUTE = 60_000;
const rule = { name: 'teste', limit: 2, windowMs: MINUTE };

/**
 * O Valkey (dublê com TTL pelo relógio do servidor, parado aqui) e o relógio dos testes. Sem o
 * `ClockSyncedRateLimitStore`, é o modo real dos e2e no CI: o `FakeClock` anda e a janela no
 * Valkey não vence.
 */
function setup() {
  let serverNow = 1_000_000;
  const redis = new WallClockRedis(() => serverNow);
  const clock = new FakeClock();
  const production = new RedisRateLimitStore(redis);
  const synced = new ClockSyncedRateLimitStore(production, redis, clock);
  return {
    redis,
    clock,
    production,
    synced,
    passServerTime: (ms: number) => {
      serverNow += ms;
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('rate limit no modo real dos e2e (Valkey com TTL do servidor)', () => {
  it('[AUTH-07] controle (a falha do CI): sem sincronizar, avançar o FakeClock não reinicia a janela', async () => {
    const { clock, production } = setup();
    const limiter = new RateLimiterService(production);
    await limiter.consume(rule, 'ip');
    await limiter.consume(rule, 'ip');
    expect(await rejection(limiter.consume(rule, 'ip'))).toBeInstanceOf(DomainError);
    clock.advance(MINUTE + 1);
    // O Valkey não viu o tempo passar: continua 429.
    expect(await rejection(limiter.consume(rule, 'ip'))).toMatchObject({ httpStatus: 429 });
  });

  it('[AUTH-07] sincronizado: o 3º no minuto é 429; depois de 1 min no FakeClock a janela reinicia', async () => {
    const { clock, synced } = setup();
    const limiter = new RateLimiterService(synced);
    await limiter.consume(rule, 'ip');
    await limiter.consume(rule, 'ip');
    expect(await rejection(limiter.consume(rule, 'ip'))).toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      details: { retryAfterS: 60 },
    });
    clock.advance(MINUTE);
    await limiter.consume(rule, 'ip');
    await limiter.consume(rule, 'ip');
    expect(await rejection(limiter.consume(rule, 'ip'))).toMatchObject({ httpStatus: 429 });
  });

  it('[AUTH-07] menos que a janela continua 429, com o Retry-After descontado', async () => {
    const { clock, synced } = setup();
    const limiter = new RateLimiterService(synced);
    await limiter.consume(rule, 'ip');
    await limiter.consume(rule, 'ip');
    clock.advance(45_000);
    expect(await rejection(limiter.consume(rule, 'ip'))).toMatchObject({
      httpStatus: 429,
      details: { retryAfterS: 15 },
    });
    clock.advance(14_999);
    expect(await rejection(limiter.consume(rule, 'ip'))).toMatchObject({
      details: { retryAfterS: 1 },
    });
    clock.advance(1);
    await limiter.consume(rule, 'ip');
  });

  it('o tempo do servidor e o do FakeClock se somam (o TTL vence pelo que vier primeiro)', async () => {
    const { clock, synced, passServerTime } = setup();
    expect((await synced.hit('rl:teste:ip', MINUTE)).count).toBe(1);
    passServerTime(40_000);
    clock.advance(20_000);
    expect((await synced.hit('rl:teste:ip', MINUTE)).count).toBe(1);
  });

  it('relógio voltando (reset entre testes) não mexe nas chaves; o próximo avanço conta da nova base', async () => {
    const { redis, clock, synced } = setup();
    clock.advance(10 * MINUTE);
    await synced.hit('rl:teste:ip', MINUTE);
    clock.reset();
    expect((await synced.hit('rl:teste:ip', MINUTE)).count).toBe(2);
    expect(await redis.pttl('rl:teste:ip')).toBe(MINUTE);
    synced.resync();
    clock.advance(30_000);
    const hit = await synced.hit('rl:teste:ip', MINUTE);
    expect(hit).toEqual({ count: 3, resetInMs: 30_000 });
  });

  it('só as chaves rl:* andam; o resto do índice fica como está', async () => {
    const { redis, clock, synced } = setup();
    await synced.hit('rl:teste:ip', MINUTE);
    // Outra chave com TTL (o mesmo script, outro prefixo).
    await new RedisRateLimitStore(redis).hit('outra:chave', MINUTE);
    clock.advance(20_000);
    await synced.hit('rl:teste:outro-ip', MINUTE);
    expect(await redis.pttl('rl:teste:ip')).toBe(40_000);
    expect(await redis.pttl('outra:chave')).toBe(MINUTE);
  });

  it('hits simultâneos depois do avanço esperam o desconto: nenhum conta na janela vencida', async () => {
    const { clock, synced } = setup();
    for (let index = 0; index < 5; index++) {
      await synced.hit('rl:teste:ip', MINUTE);
    }
    clock.advance(MINUTE);
    const hits = await Promise.all(
      Array.from({ length: 5 }, () => synced.hit('rl:teste:ip', MINUTE)),
    );
    expect(hits.map((hit) => hit.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
