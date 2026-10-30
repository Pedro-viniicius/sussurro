import { RATE_LIMIT_SCRIPT } from '../common/rate-limit/rate-limit.store.js';

/**
 * Dublê mínimo do Valkey para o rate limit, com a mesma semântica de TTL do servidor: as chaves
 * vencem pelo relógio do "servidor" (`now`, por padrão o relógio de verdade), nunca pelo
 * `FakeClock` dos testes. É o que faz o modo real dos e2e (Valkey do compose ou do CI) diferente
 * do fake em memória do modo PGlite. Só o necessário:
 * - `eval` só do `RATE_LIMIT_SCRIPT` de produção (INCR, PTTL e PEXPIRE, como o script Lua);
 * - `scan` (com `MATCH` de `*`), `pttl`, `pexpire`, `del` e `flushdb`.
 */
export class WallClockRedis {
  private readonly entries = new Map<string, { value: number; expiresAt: number | null }>();

  constructor(private readonly now: () => number = Date.now) {}

  // Assinatura larga para valer como o `eval` do ioredis (`RedisRateLimitStore` recebe um).
  eval(script: string | Buffer, numKeys: number | string, ...args: unknown[]): Promise<unknown> {
    if (String(script) !== RATE_LIMIT_SCRIPT || Number(numKeys) !== 1) {
      return Promise.reject(new Error('WallClockRedis: só o RATE_LIMIT_SCRIPT é suportado'));
    }
    const key = String(args[0]);
    const windowMs = Number(args[1]);
    const current = this.live(key);
    const entry = { value: (current?.value ?? 0) + 1, expiresAt: current?.expiresAt ?? null };
    this.entries.set(key, entry);
    let ttl = this.ttlOf(entry);
    if (entry.value === 1 || ttl < 0) {
      entry.expiresAt = this.now() + windowMs;
      ttl = windowMs;
    }
    return Promise.resolve([entry.value, ttl]);
  }

  scan(
    _cursor: string | number,
    _matchToken: 'MATCH',
    pattern: string,
    _countToken: 'COUNT',
    _count: number | string,
  ): Promise<[string, string[]]> {
    const matcher = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    const keys = [...this.entries.keys()].filter(
      (key) => this.live(key) !== undefined && matcher.test(key),
    );
    return Promise.resolve(['0', keys]);
  }

  pttl(key: string): Promise<number> {
    const entry = this.live(key);
    return Promise.resolve(entry === undefined ? -2 : this.ttlOf(entry));
  }

  pexpire(key: string, milliseconds: number | string): Promise<number> {
    const entry = this.live(key);
    if (entry === undefined) {
      return Promise.resolve(0);
    }
    const ms = Number(milliseconds);
    if (ms <= 0) {
      this.entries.delete(key);
    } else {
      entry.expiresAt = this.now() + ms;
    }
    return Promise.resolve(1);
  }

  del(...keys: string[]): Promise<number> {
    return Promise.resolve(keys.filter((key) => this.entries.delete(key)).length);
  }

  flushdb(): Promise<'OK'> {
    this.entries.clear();
    return Promise.resolve('OK');
  }

  /** A entrada, se ainda não venceu (vencida sai, como no servidor). */
  private live(key: string): { value: number; expiresAt: number | null } | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt != null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private ttlOf(entry: { expiresAt: number | null }): number {
    return entry.expiresAt === null ? -1 : entry.expiresAt - this.now();
  }
}
