import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { pingDatabase, type DbHandle } from '@sussurro/db';
import type { DependencyCheck, HealthReady } from '@sussurro/shared';
import type { Redis } from 'ioredis';

import { describeError } from '../../common/errors/describe-error.js';
import { DATABASE } from '../database/database.providers.js';
import { REDIS } from '../redis/redis.providers.js';

/** Tempo máximo de cada verificação. Com Redis ou Postgres fora, o /ready responde em ~1 s. */
export const HEALTH_CHECK_TIMEOUT_MS = Symbol('HEALTH_CHECK_TIMEOUT_MS');
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 1_000;

class CheckTimeoutError extends Error {
  constructor(ms: number) {
    super(`sem resposta em ${ms} ms`);
    this.name = 'CheckTimeoutError';
  }
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject(DATABASE) private readonly database: Pick<DbHandle, 'db'>,
    @Inject(REDIS) private readonly redis: Pick<Redis, 'ping'>,
    @Optional() @Inject(HEALTH_CHECK_TIMEOUT_MS) timeoutMs?: number,
  ) {
    this.timeoutMs = timeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  }

  async readiness(): Promise<HealthReady> {
    const [postgres, redis] = await Promise.all([
      this.check('postgres', async () => {
        await pingDatabase(this.database);
      }),
      this.check('redis', async () => {
        await this.redis.ping();
      }),
    ]);
    const status = postgres.status === 'up' && redis.status === 'up' ? 'ok' : 'error';
    return { status, checks: { postgres, redis } };
  }

  private async check(name: string, probe: () => Promise<void>): Promise<DependencyCheck> {
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new CheckTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });
    const operation = probe();
    // Se o timeout vencer, a operação continua e pode rejeitar depois: não deixar
    // essa rejeição sem tratamento (derrubaria o processo).
    operation.catch(() => undefined);
    try {
      await Promise.race([operation, timeout]);
      return { status: 'up', latencyMs: elapsed(startedAt) };
    } catch (error) {
      this.logger.warn(`${name} indisponível: ${describeError(error)}`);
      return { status: 'down', latencyMs: elapsed(startedAt) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
