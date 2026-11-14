import type { Redis } from 'ioredis';

import type { Clock } from '../../common/clock/clock.js';
import { RATE_LIMIT_SCRIPT, type RateLimitHit } from '../../common/rate-limit/rate-limit.store.js';

/**
 * Dono e emissão de um token de proximidade. O token em si nunca é guardado (só o hash). (ADR 0013
 * §1) Um token só por emissão, o mesmo no QR e no NFC: o registro não tem mais canal.
 */
export interface ProximityTokenRecord {
  userId: string;
  /** Emissão em ms (relógio da API): escolhe o token mais recente de cada pessoa. */
  issuedAt: number;
}

/** Validades do token (ADR 0003): válido 30 s, recente 120 s, tela aberta 30 s. */
export interface ProximityTtls {
  validMs: number;
  recentMs: number;
  screenMs: number;
}

/**
 * Chaves no Redis (arquitetura.md §6, Fase 4; ADR 0013). `hash` = SHA-256 do token. Nenhuma chave
 * guarda token em claro nem dado do aparelho.
 */
export const proximityKeys = {
  /** Token **válido** (`{uid, iat}`): `resolve` e pedido. */
  valid: (hash: string) => `prox:t:${hash}`,
  /** Token **recente** (o mesmo registro): aceite (leitura cruzada, D7). */
  recent: (hash: string) => `prox:r:${hash}`,
  /** Tela Conectar aberta (o hash do último token). */
  screen: (userId: string) => `prox:u:${userId}`,
  /** Hashes emitidos pela conta nos últimos 120 s, para invalidar no logout e na exclusão. */
  issued: (userId: string) => `prox:ut:${userId}`,
  /** Proximidade bloqueada depois de 20 falhas de token em 10 min. */
  lock: (userId: string) => `prox:lock:${userId}`,
};

/**
 * Porta do estado efêmero da proximidade (tokens, tela aberta, contadores de abuso e bloqueio). Em
 * produção é o Redis/Valkey; o fake em memória (`MemoryProximityStore`) serve aos testes, com o
 * `Clock` controlando as validades, e ao desenvolvimento sem Docker (`PROXIMITY_STORE=memory`).
 *
 * Quem usa trata qualquer erro como indisponível e fecha a proximidade (fail-closed, R11).
 */
export abstract class ProximityStore {
  /** Grava o token como válido e recente, marca a tela aberta e indexa o hash na conta. */
  abstract issue(hash: string, record: ProximityTokenRecord, ttls: ProximityTtls): Promise<void>;
  /** Registro de cada hash ainda **válido**, na ordem pedida (`null` se vencido ou inexistente). */
  abstract findValid(hashes: readonly string[]): Promise<(ProximityTokenRecord | null)[]>;
  /** Registro do hash **válido ou recente** (até 120 s depois da emissão). */
  abstract findRecent(hash: string): Promise<ProximityTokenRecord | null>;
  abstract isScreenOpen(userId: string): Promise<boolean>;
  /** Invalida todos os tokens da conta e a marca de tela aberta (logout e exclusão, PROX-27). */
  abstract revokeUser(userId: string): Promise<void>;
  /** Contador de janela fixa (a mesma semântica do rate limit da API). */
  abstract hit(key: string, windowMs: number): Promise<RateLimitHit>;
  abstract lock(userId: string, ms: number): Promise<void>;
  /** Quanto falta para o bloqueio acabar (0 = sem bloqueio). */
  abstract lockRemainingMs(userId: string): Promise<number>;
}

function encodeRecord(record: ProximityTokenRecord): string {
  return JSON.stringify({ uid: record.userId, iat: record.issuedAt });
}

/**
 * Registro ilegível = inexistente. (ADR 0013) Um registro da ADR 0012 com canal `ble` (o token que
 * ia no anúncio Bluetooth, legível a metros) também: ele não pode virar pessoa no `resolve` nos até
 * 120 s em que ainda vive depois da troca de versão. O canal `qr` antigo continua valendo.
 */
function decodeRecord(value: string | null | undefined): ProximityTokenRecord | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as { uid?: unknown; iat?: unknown; ch?: unknown };
    return typeof parsed.uid === 'string' &&
      typeof parsed.iat === 'number' &&
      (parsed.ch === undefined || parsed.ch === 'qr')
      ? { userId: parsed.uid, issuedAt: parsed.iat }
      : null;
  } catch {
    return null;
  }
}

type ProximityRedis = Pick<
  Redis,
  'multi' | 'mget' | 'get' | 'exists' | 'smembers' | 'del' | 'set' | 'pttl' | 'eval'
>;

export class RedisProximityStore extends ProximityStore {
  constructor(private readonly redis: ProximityRedis) {
    super();
  }

  async issue(hash: string, record: ProximityTokenRecord, ttls: ProximityTtls): Promise<void> {
    const value = encodeRecord(record);
    const results = await this.redis
      .multi()
      .set(proximityKeys.valid(hash), value, 'PX', ttls.validMs)
      .set(proximityKeys.recent(hash), value, 'PX', ttls.recentMs)
      .set(proximityKeys.screen(record.userId), hash, 'PX', ttls.screenMs)
      .sadd(proximityKeys.issued(record.userId), hash)
      .pexpire(proximityKeys.issued(record.userId), ttls.recentMs)
      .exec();
    const failed = results?.find(([error]) => error !== null);
    if (results === null || failed !== undefined) {
      throw failed?.[0] ?? new Error('MULTI do token de proximidade não executou');
    }
  }

  async findValid(hashes: readonly string[]): Promise<(ProximityTokenRecord | null)[]> {
    if (hashes.length === 0) {
      return [];
    }
    const values = await this.redis.mget(...hashes.map(proximityKeys.valid));
    return values.map(decodeRecord);
  }

  async findRecent(hash: string): Promise<ProximityTokenRecord | null> {
    return decodeRecord(await this.redis.get(proximityKeys.recent(hash)));
  }

  async isScreenOpen(userId: string): Promise<boolean> {
    return (await this.redis.exists(proximityKeys.screen(userId))) === 1;
  }

  async revokeUser(userId: string): Promise<void> {
    const hashes = await this.redis.smembers(proximityKeys.issued(userId));
    await this.redis.del(
      ...hashes.flatMap((hash) => [proximityKeys.valid(hash), proximityKeys.recent(hash)]),
      proximityKeys.screen(userId),
      proximityKeys.issued(userId),
    );
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const [count, ttl] = (await this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, String(windowMs))) as [
      number,
      number,
    ];
    return { count, resetInMs: ttl > 0 ? ttl : windowMs };
  }

  async lock(userId: string, ms: number): Promise<void> {
    await this.redis.set(proximityKeys.lock(userId), '1', 'PX', ms);
  }

  async lockRemainingMs(userId: string): Promise<number> {
    const ttl = await this.redis.pttl(proximityKeys.lock(userId));
    return ttl > 0 ? ttl : 0;
  }
}

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

/** Acima deste número de chaves, cada emissão varre as vencidas (processo de dev de longa duração). */
const SWEEP_THRESHOLD = 1_000;

/**
 * Fake em memória da porta, com as mesmas chaves e validades do Redis sobre o `Clock`. Nos testes,
 * o relógio avança em vez de esperar os 30 ou 120 s (sem `sleep`). Em desenvolvimento sem Docker
 * (`PROXIMITY_STORE=memory`), vale para uma instância só da API e some ao reiniciar.
 */
export class MemoryProximityStore extends ProximityStore {
  private readonly values = new Map<string, Expiring<string>>();
  private readonly sets = new Map<string, Expiring<Set<string>>>();
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly clock: Clock) {
    super();
  }

  private now(): number {
    return this.clock.now().getTime();
  }

  private read(key: string): string | null {
    const entry = this.values.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  private write(key: string, value: string, ttlMs: number): void {
    this.values.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  private sweep(): void {
    if (this.values.size < SWEEP_THRESHOLD) {
      return;
    }
    const now = this.now();
    for (const [key, entry] of this.values) {
      if (entry.expiresAt <= now) {
        this.values.delete(key);
      }
    }
    for (const [key, entry] of this.sets) {
      if (entry.expiresAt <= now) {
        this.sets.delete(key);
      }
    }
  }

  issue(hash: string, record: ProximityTokenRecord, ttls: ProximityTtls): Promise<void> {
    this.sweep();
    const value = encodeRecord(record);
    this.write(proximityKeys.valid(hash), value, ttls.validMs);
    this.write(proximityKeys.recent(hash), value, ttls.recentMs);
    this.write(proximityKeys.screen(record.userId), hash, ttls.screenMs);
    const key = proximityKeys.issued(record.userId);
    const current = this.sets.get(key);
    const members =
      current !== undefined && current.expiresAt > this.now() ? current.value : new Set<string>();
    members.add(hash);
    this.sets.set(key, { value: members, expiresAt: this.now() + ttls.recentMs });
    return Promise.resolve();
  }

  findValid(hashes: readonly string[]): Promise<(ProximityTokenRecord | null)[]> {
    return Promise.resolve(
      hashes.map((hash) => decodeRecord(this.read(proximityKeys.valid(hash)))),
    );
  }

  findRecent(hash: string): Promise<ProximityTokenRecord | null> {
    return Promise.resolve(decodeRecord(this.read(proximityKeys.recent(hash))));
  }

  isScreenOpen(userId: string): Promise<boolean> {
    return Promise.resolve(this.read(proximityKeys.screen(userId)) !== null);
  }

  revokeUser(userId: string): Promise<void> {
    const key = proximityKeys.issued(userId);
    for (const hash of this.sets.get(key)?.value ?? []) {
      this.values.delete(proximityKeys.valid(hash));
      this.values.delete(proximityKeys.recent(hash));
    }
    this.values.delete(proximityKeys.screen(userId));
    this.sets.delete(key);
    return Promise.resolve();
  }

  /** `INCR` com a janela fixa aberta no primeiro (o `RATE_LIMIT_SCRIPT`). */
  private increment(key: string, windowMs: number): RateLimitHit {
    const now = this.now();
    const current = this.counters.get(key);
    const window =
      current === undefined || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
    this.counters.set(key, window);
    return { count: window.count, resetInMs: window.resetAt - now };
  }

  hit(key: string, windowMs: number): Promise<RateLimitHit> {
    return Promise.resolve(this.increment(key, windowMs));
  }

  lock(userId: string, ms: number): Promise<void> {
    this.write(proximityKeys.lock(userId), '1', ms);
    return Promise.resolve();
  }

  lockRemainingMs(userId: string): Promise<number> {
    const key = proximityKeys.lock(userId);
    if (this.read(key) === null) {
      return Promise.resolve(0);
    }
    return Promise.resolve((this.values.get(key)?.expiresAt ?? 0) - this.now());
  }

  /** Chaves e valores vivos (PROX-01: o teste confere que o token nunca aparece em claro). */
  entries(): { key: string; value: string }[] {
    const now = this.now();
    const plain = [...this.values]
      .filter(([, entry]) => entry.expiresAt > now)
      .map(([key, entry]) => ({ key, value: entry.value }));
    const sets = [...this.sets]
      .filter(([, entry]) => entry.expiresAt > now)
      .map(([key, entry]) => ({ key, value: [...entry.value].join(',') }));
    return [...plain, ...sets];
  }

  clear(): void {
    this.values.clear();
    this.sets.clear();
    this.counters.clear();
  }
}
