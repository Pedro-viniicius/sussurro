import { describe, expect, it, vi } from 'vitest';

import { RATE_LIMIT_SCRIPT, RedisRateLimitStore, type RateLimitStore } from './rate-limit.store.js';
import { RATE_LIMITS, RateLimiterService, rateLimitSubject } from './rate-limiter.service.js';
import { FakeClock } from '../../testing/fake-clock.js';
import { InMemoryRateLimitStore } from '../../testing/in-memory-rate-limit.store.js';
import { DomainError } from '../errors/domain-error.js';

const rule = { name: 'teste', limit: 2, windowMs: 60_000 };

describe('RateLimiterService', () => {
  it('[AUTH-07] libera até o limite e lança 429 com retryAfterS depois', async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiterService(new InMemoryRateLimitStore(clock));
    await limiter.consume(rule, 'ip');
    await limiter.consume(rule, 'ip');
    clock.advance(15_000);
    const error = await limiter.consume(rule, 'ip').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      details: { retryAfterS: 45 },
    });
    // Outro sujeito tem contador próprio; a janela reinicia depois do tempo.
    await limiter.consume(rule, 'outro-ip');
    clock.advance(45_000);
    await limiter.consume(rule, 'ip');
  });

  it('R11: Redis com erro ou lento → deixa passar (fail-open)', async () => {
    const failing: RateLimitStore = { hit: () => Promise.reject(new Error('ECONNREFUSED')) };
    await expect(new RateLimiterService(failing).consume(rule, 'ip')).resolves.toBeUndefined();

    vi.useFakeTimers();
    try {
      const slow: RateLimitStore = { hit: () => new Promise(() => undefined) };
      const pending = new RateLimiterService(slow).consume(rule, 'ip');
      await vi.advanceTimersByTimeAsync(300);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('e-mail entra na chave como hash (sem dado pessoal no Redis)', () => {
    const subject = rateLimitSubject('ana@example.com');
    expect(subject).not.toContain('ana');
    expect(subject).toHaveLength(32);
  });

  it('limites do ADR 0007 e do A-05', () => {
    expect(RATE_LIMITS.loginPerIpAndEmail).toMatchObject({ limit: 5, windowMs: 60_000 });
    expect(RATE_LIMITS.loginPerIp).toMatchObject({ limit: 20, windowMs: 60_000 });
    expect(RATE_LIMITS.registerPerIp).toMatchObject({ limit: 5, windowMs: 3_600_000 });
  });
});

describe('RedisRateLimitStore', () => {
  it('roda o script Lua com a chave e a janela, e converte a resposta', async () => {
    const evalFn = vi.fn().mockResolvedValue([3, 1500]);
    const store = new RedisRateLimitStore({ eval: evalFn });
    await expect(store.hit('rl:x', 60_000)).resolves.toEqual({ count: 3, resetInMs: 1500 });
    expect(evalFn).toHaveBeenCalledWith(RATE_LIMIT_SCRIPT, 1, 'rl:x', '60000');
  });

  it('TTL ausente vira a janela inteira', async () => {
    const store = new RedisRateLimitStore({ eval: vi.fn().mockResolvedValue([1, -1]) });
    await expect(store.hit('rl:x', 60_000)).resolves.toEqual({ count: 1, resetInMs: 60_000 });
  });
});
