import type { Clock } from '../common/clock/clock.js';
import { type RateLimitHit, RateLimitStore } from '../common/rate-limit/rate-limit.store.js';

/**
 * Fake em memória da porta `RateLimitStore`, com a mesma semântica de janela fixa do script Lua do
 * Redis, sobre o `Clock`. Usado no modo TEST_DB=pglite (sem Valkey).
 */
export class InMemoryRateLimitStore extends RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly clock: Clock) {
    super();
  }

  hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = this.clock.now().getTime();
    const current = this.windows.get(key);
    const window =
      current === undefined || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
    this.windows.set(key, window);
    return Promise.resolve({ count: window.count, resetInMs: window.resetAt - now });
  }

  clear(): void {
    this.windows.clear();
  }
}
