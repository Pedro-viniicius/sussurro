import { CounterCache } from '../common/cache/counter-cache.js';
import type { Clock } from '../common/clock/clock.js';

/**
 * Fake em memória da porta `CounterCache`, com validade sobre o `Clock` (os testes avançam o
 * relógio em vez de esperar os 60 s do cache de seguidores, CNT-02). Usado nos dois modos de
 * `TEST_DB`; o adaptador Redis tem teste próprio contra o Valkey (`real-services.e2e-spec.ts`).
 */
export class InMemoryCounterCache extends CounterCache {
  private readonly values = new Map<string, { value: number; expiresAt: number }>();

  constructor(private readonly clock: Clock) {
    super();
  }

  getMany(keys: readonly string[]): Promise<(number | null)[]> {
    const now = this.clock.now().getTime();
    return Promise.resolve(
      keys.map((key) => {
        const entry = this.values.get(key);
        return entry !== undefined && entry.expiresAt > now ? entry.value : null;
      }),
    );
  }

  setMany(entries: readonly { key: string; value: number }[], ttlMs: number): Promise<void> {
    const expiresAt = this.clock.now().getTime() + ttlMs;
    for (const entry of entries) {
      this.values.set(entry.key, { value: entry.value, expiresAt });
    }
    return Promise.resolve();
  }

  clear(): void {
    this.values.clear();
  }
}
