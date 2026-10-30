import type { Redis } from 'ioredis';

export interface RateLimitHit {
  /** Requisições contadas na janela atual, incluindo esta. */
  count: number;
  /** Quanto falta para a janela reiniciar (ms). */
  resetInMs: number;
}

/**
 * Porta do contador de rate limit (janela fixa). Em produção é o Redis/Valkey; nos testes sem
 * Docker (TEST_DB=pglite), um fake em memória que implementa esta mesma porta.
 */
export abstract class RateLimitStore {
  abstract hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

/**
 * INCR + PEXPIRE atômicos num script Lua: a primeira requisição da janela define a expiração, e um
 * contador sem TTL (ex.: após falha entre os dois comandos) nunca fica preso.
 */
export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export class RedisRateLimitStore extends RateLimitStore {
  constructor(private readonly redis: Pick<Redis, 'eval'>) {
    super();
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const [count, ttl] = (await this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, String(windowMs))) as [
      number,
      number,
    ];
    return { count, resetInMs: ttl > 0 ? ttl : windowMs };
  }
}
