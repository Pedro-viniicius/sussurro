import type { RateLimitHit } from '../common/rate-limit/rate-limit.store.js';
import {
  type BlockSignalCounts,
  type ClaimTouchPairInput,
  MemoryProximityStore,
  type OwedCard,
  type ProximityStore,
  type ProximityTokenRecord,
  type ProximityTtls,
  type TouchClaim,
} from '../modules/proximity/proximity.store.js';

/** Nome de uma operação da porta (para derrubar só ela, `failing`). */
export type ProximityStoreOperation = keyof ProximityStore;

/**
 * O fake em memória da proximidade (validades sobre o relógio de teste, sem `sleep`), com três
 * interruptores de queda (PROX-21, PROX-35, PROX-54, PROX-61):
 * - `down = true`: toda operação falha como um Redis fora do ar;
 * - `failing`: só as operações listadas falham (ex.: `claimTouchPair`), para provar que cada passo
 *   do encostar também fecha a proximidade (503), e não só o primeiro acesso ao Redis;
 * - `stalling`: só as operações listadas nunca respondem (o Valkey lento); quem chama desiste no
 *   prazo de 500 ms (`withTimeout`, relógio de verdade), então cada chamada custa meio segundo.
 *
 * Toda operação da porta tem o seu override, inclusive o `countBlockSignal` (o sinal de abuso, em
 * falha aberta, PROX-55 e PROX-63) e o `hasTouchPair` (o par que o bloqueio e a denúncia pelo cartão
 * consultam em falha fechada, PROX-61 e PROX-62).
 *
 * E um registro só de leitura para os e2e (ADR 0012, A2): `claims` guarda o resultado de cada
 * casamento (`created`, `renewed`, `capped`, `busy` ou `gone`), que a resposta HTTP não distingue
 * de propósito (PROX-46). Assim o teste prova **por que** o encosto não confirmou, e não só que não
 * confirmou. Usado nos dois modos de `TEST_DB`; o adaptador Redis tem teste próprio contra o Valkey
 * (`real-services`, PROX-56).
 */
export class TestProximityStore extends MemoryProximityStore {
  down = false;
  readonly failing = new Set<ProximityStoreOperation>();
  readonly stalling = new Set<ProximityStoreOperation>();
  /** Resultado de cada `claimTouchPair` que chegou ao fake, na ordem. */
  readonly claims: TouchClaim[] = [];
  /**
   * (A2 rev. 1, R1-6) Resultado de cada `countBlockSignal` que chegou ao fake, na ordem: os dois
   * contadores depois da soma, ou `null` (sem par, ou o sentido já contado neste casamento). O
   * bloqueio responde 204 nos dois casos, então é aqui que o teste vê se o sinal contou.
   */
  readonly blockSignals: (BlockSignalCounts | null)[] = [];

  private outage<T>(name: ProximityStoreOperation, operation: () => Promise<T>): Promise<T> {
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

  override recordTouch(
    observerId: string,
    ownerId: string,
    ownerTokenHash: string,
    atMs: number,
    windowMs: number,
  ): Promise<boolean> {
    return this.outage('recordTouch', () =>
      super.recordTouch(observerId, ownerId, ownerTokenHash, atMs, windowMs),
    );
  }

  override claimTouchPair(input: ClaimTouchPairInput): Promise<TouchClaim> {
    return this.outage('claimTouchPair', async () => {
      const outcome = await super.claimTouchPair(input);
      this.claims.push(outcome);
      return outcome;
    });
  }

  override takeOwedCard(recipientId: string, busyMs: number): Promise<OwedCard | null> {
    return this.outage('takeOwedCard', () => super.takeOwedCard(recipientId, busyMs));
  }

  override markTouchPair(
    first: string,
    second: string,
    ttlMs: number,
    atMs: number,
  ): Promise<void> {
    return this.outage('markTouchPair', () => super.markTouchPair(first, second, ttlMs, atMs));
  }

  override hasTouchPair(first: string, second: string): Promise<boolean> {
    return this.outage('hasTouchPair', () => super.hasTouchPair(first, second));
  }

  override countBlockSignal(
    blockerId: string,
    blockedId: string,
    windowMs: number,
  ): Promise<BlockSignalCounts | null> {
    return this.outage('countBlockSignal', async () => {
      const counts = await super.countBlockSignal(blockerId, blockedId, windowMs);
      this.blockSignals.push(counts);
      return counts;
    });
  }

  override forgetTouchState(userId: string): Promise<void> {
    return this.outage('forgetTouchState', () => super.forgetTouchState(userId));
  }

  override clear(): void {
    super.clear();
    this.down = false;
    this.failing.clear();
    this.stalling.clear();
    this.claims.length = 0;
    this.blockSignals.length = 0;
  }
}
