import type { RateLimitHit } from '../common/rate-limit/rate-limit.store.js';
import {
  MemoryProximityStore,
  type ProximityTokenRecord,
  type ProximityTtls,
} from '../modules/proximity/proximity.store.js';

/**
 * O fake em memória da proximidade (validades sobre o relógio de teste, sem `sleep`), com um
 * interruptor de queda: com `down = true`, toda operação falha como um Redis fora do ar (PROX-21).
 * Usado nos dois modos de `TEST_DB`; o adaptador Redis tem teste próprio contra o Valkey.
 */
export class TestProximityStore extends MemoryProximityStore {
  down = false;

  private outage<T>(operation: () => Promise<T>): Promise<T> {
    return this.down ? Promise.reject(new Error('Redis fora do ar (simulado)')) : operation();
  }

  override issue(hash: string, record: ProximityTokenRecord, ttls: ProximityTtls): Promise<void> {
    return this.outage(() => super.issue(hash, record, ttls));
  }

  override findValid(hashes: readonly string[]): Promise<(ProximityTokenRecord | null)[]> {
    return this.outage(() => super.findValid(hashes));
  }

  override findRecent(hash: string): Promise<ProximityTokenRecord | null> {
    return this.outage(() => super.findRecent(hash));
  }

  override isScreenOpen(userId: string): Promise<boolean> {
    return this.outage(() => super.isScreenOpen(userId));
  }

  override revokeUser(userId: string): Promise<void> {
    return this.outage(() => super.revokeUser(userId));
  }

  override hit(key: string, windowMs: number): Promise<RateLimitHit> {
    return this.outage(() => super.hit(key, windowMs));
  }

  override lock(userId: string, ms: number): Promise<void> {
    return this.outage(() => super.lock(userId, ms));
  }

  override lockRemainingMs(userId: string): Promise<number> {
    return this.outage(() => super.lockRemainingMs(userId));
  }

  override clear(): void {
    super.clear();
    this.down = false;
  }
}
