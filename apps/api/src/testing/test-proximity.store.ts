import type { RateLimitHit } from '../common/rate-limit/rate-limit.store.js';
import {
  MemoryProximityStore,
  type ProximityStore,
  type ProximityTokenRecord,
  type ProximityTtls,
} from '../modules/proximity/proximity.store.js';

/** Nome de uma operação da porta (para derrubar só ela, `failing`). */
export type ProximityStoreOperation = keyof ProximityStore;

/**
 * Uma ida registrada em `calls`: uma operação da porta ou o `findNearby` do `ProximityRepository`
 * (a consulta do `resolve`), que o `createTestApp` anota aqui.
 */
export type RecordedProximityCall = ProximityStoreOperation | 'findNearby';

/**
 * O fake em memória da proximidade (validades sobre o relógio de teste, sem `sleep`), com três
 * interruptores de queda (PROX-21):
 * - `down = true`: toda operação falha como um Redis fora do ar;
 * - `failing`: só as operações listadas falham, para provar que cada passo também fecha a
 *   proximidade (503), e não só o primeiro acesso ao Redis;
 * - `stalling`: só as operações listadas nunca respondem (o Valkey lento); quem chama desiste no
 *   prazo de 500 ms (`withTimeout`, relógio de verdade), então cada chamada custa meio segundo.
 *
 * E o registro `calls`: cada ida, na ordem em que chegou, **antes** de qualquer queda simulada.
 *
 * Usado nos dois modos de `TEST_DB`; o adaptador Redis tem teste próprio contra o Valkey
 * (`real-services`, PROX-56).
 */
export class TestProximityStore extends MemoryProximityStore {
  down = false;
  readonly failing = new Set<ProximityStoreOperation>();
  readonly stalling = new Set<ProximityStoreOperation>();
  /** Cada ida ao fake (e o `findNearby` do repositório), na ordem. */
  readonly calls: RecordedProximityCall[] = [];

  /** Anota uma ida que não é da porta (o `findNearby` do repositório; ver `createTestApp`). */
  noteCall(name: RecordedProximityCall): void {
    this.calls.push(name);
  }

  private outage<T>(name: ProximityStoreOperation, operation: () => Promise<T>): Promise<T> {
    this.calls.push(name);
    if (this.stalling.has(name)) {
      return new Promise<T>(() => undefined);
    }
    return this.down || this.failing.has(name)
      ? Promise.reject(new Error(`Redis fora do ar (simulado: ${name})`))
      : operation();
  }

  override issue(hash: string, record: ProximityTokenRecord, ttls: ProximityTtls): Promise<void> {
    return this.outage('issue', () => super.issue(hash, record, ttls));
  }

  override findValid(hashes: readonly string[]): Promise<(ProximityTokenRecord | null)[]> {
    return this.outage('findValid', () => super.findValid(hashes));
  }

  override findRecent(hash: string): Promise<ProximityTokenRecord | null> {
    return this.outage('findRecent', () => super.findRecent(hash));
  }

  override isScreenOpen(userId: string): Promise<boolean> {
    return this.outage('isScreenOpen', () => super.isScreenOpen(userId));
  }

  override revokeUser(userId: string): Promise<void> {
    return this.outage('revokeUser', () => super.revokeUser(userId));
  }

  override hit(key: string, windowMs: number): Promise<RateLimitHit> {
    return this.outage('hit', () => super.hit(key, windowMs));
  }

  override lock(userId: string, ms: number): Promise<void> {
    return this.outage('lock', () => super.lock(userId, ms));
  }

  override lockRemainingMs(userId: string): Promise<number> {
    return this.outage('lockRemainingMs', () => super.lockRemainingMs(userId));
  }

  override clear(): void {
    super.clear();
    this.down = false;
    this.failing.clear();
    this.stalling.clear();
    this.calls.length = 0;
  }
}
