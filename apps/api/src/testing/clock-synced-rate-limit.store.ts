import type { Clock } from '../common/clock/clock.js';
import { type RateLimitHit, RateLimitStore } from '../common/rate-limit/rate-limit.store.js';

/** O que este store usa do cliente `ioredis` (ou do `WallClockRedis`). */
export interface TtlRedis {
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  pttl(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

/** Prefixo das chaves do `RateLimiterService` (`rl:<regra>:<sujeito>`). */
export const RATE_LIMIT_KEY_PATTERN = 'rl:*';

/**
 * Rate limit do modo real dos e2e (Valkey do compose ou do CI). No Valkey a janela vence pelo TTL
 * do servidor, com o relógio de verdade; os testes avançam o `FakeClock` (A-27) e esperam a janela
 * reiniciar, como no fake em memória do modo PGlite. Este store repassa cada `hit` ao store de
 * produção (`RedisRateLimitStore`, o script Lua no Valkey de verdade) e, antes, desconta do TTL de
 * cada chave `rl:*` o tempo que o `FakeClock` andou desde o último `hit`: a chave cujo TTL acaba
 * nesse intervalo sai, como sairia no servidor. O relógio voltando (`reset`, `set` para trás) só
 * ressincroniza; o `reset` do app de teste ainda esvazia o índice com `flushdb`.
 */
export class ClockSyncedRateLimitStore extends RateLimitStore {
  private syncedAt: number;
  /** O desconto em curso: os `hit` simultâneos esperam por ele antes de contar. */
  private shifting: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: RateLimitStore,
    private readonly redis: TtlRedis,
    private readonly clock: Clock,
  ) {
    super();
    this.syncedAt = clock.now().getTime();
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = this.clock.now().getTime();
    const elapsed = now - this.syncedAt;
    this.syncedAt = now;
    if (elapsed > 0) {
      const run = this.shifting.then(() => this.shiftTtls(elapsed));
      this.shifting = run.catch(() => undefined);
      await run;
    } else {
      await this.shifting;
    }
    return this.inner.hit(key, windowMs);
  }

  /** Depois do `flushdb` e do `clock.reset()` entre testes. */
  resync(): void {
    this.syncedAt = this.clock.now().getTime();
  }

  private async shiftTtls(elapsed: number): Promise<void> {
    // O SCAN pode repetir chaves: cada uma é descontada uma vez só.
    const keys = new Set<string>();
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        RATE_LIMIT_KEY_PATTERN,
        'COUNT',
        100,
      );
      cursor = next;
      for (const key of batch) {
        keys.add(key);
      }
    } while (cursor !== '0');
    for (const key of keys) {
      const ttl = await this.redis.pttl(key);
      if (ttl < 0) {
        // -2: já venceu; -1: sem TTL (o script de produção corrige no próximo hit).
        continue;
      }
      if (ttl <= elapsed) {
        await this.redis.del(key);
      } else {
        await this.redis.pexpire(key, ttl - elapsed);
      }
    }
  }
}
