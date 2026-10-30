import type { Redis } from 'ioredis';

/**
 * Porta do cache de contadores (ADR 0004: número de seguidores de criador com cache de 60 s). Em
 * produção é o Redis/Valkey; nos testes, um fake em memória sobre o `Clock` (os dois modos de
 * `TEST_DB`), como o S3 e a fila.
 */
export abstract class CounterCache {
  /** Valores na ordem das chaves; `null` para a chave ausente ou vencida. */
  abstract getMany(keys: readonly string[]): Promise<(number | null)[]>;
  abstract setMany(
    entries: readonly { key: string; value: number }[],
    ttlMs: number,
  ): Promise<void>;
}

export class RedisCounterCache extends CounterCache {
  constructor(private readonly redis: Pick<Redis, 'mget' | 'multi'>) {
    super();
  }

  async getMany(keys: readonly string[]): Promise<(number | null)[]> {
    if (keys.length === 0) {
      return [];
    }
    const values = await this.redis.mget(...keys);
    return values.map((value) => {
      if (value === null) {
        return null;
      }
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    });
  }

  async setMany(entries: readonly { key: string; value: number }[], ttlMs: number): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const pipeline = this.redis.multi();
    for (const entry of entries) {
      pipeline.set(entry.key, String(entry.value), 'PX', ttlMs);
    }
    await pipeline.exec();
  }
}
