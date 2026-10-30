import { HealthReadySchema } from '@sussurro/shared';
import { describe, expect, it } from 'vitest';

import { HealthService } from './health.service.js';
import { fakeDependencies } from '../../testing/test-env.js';

const never = () => new Promise<never>(() => undefined);

describe('HealthService.readiness', () => {
  it('Postgres e Redis up: status ok', async () => {
    const { database, redis } = fakeDependencies();
    const result = await new HealthService(database as never, redis as never).readiness();
    expect(result.status).toBe('ok');
    expect(result.checks.postgres.status).toBe('up');
    expect(result.checks.redis.status).toBe('up');
    expect(HealthReadySchema.safeParse(result).success).toBe(true);
    expect(database.db.execute).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('F0-API-03: Redis recusando conexão: redis down e status error', async () => {
    const { database, redis } = fakeDependencies();
    redis.ping.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    const result = await new HealthService(database as never, redis as never).readiness();
    expect(result.status).toBe('error');
    expect(result.checks).toMatchObject({ postgres: { status: 'up' }, redis: { status: 'down' } });
  });

  it('F0-API-04: Postgres fora: postgres down', async () => {
    const { database, redis } = fakeDependencies();
    database.db.execute.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const result = await new HealthService(database as never, redis as never).readiness();
    expect(result.status).toBe('error');
    expect(result.checks.postgres.status).toBe('down');
  });

  it('dependência que não responde vira down no timeout, sem travar', async () => {
    const { database, redis } = fakeDependencies();
    redis.ping.mockImplementation(never);
    database.db.execute.mockImplementation(never);
    const startedAt = Date.now();
    const result = await new HealthService(database as never, redis as never, 50).readiness();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.status).toBe('error');
    expect(result.checks.postgres).toMatchObject({ status: 'down' });
    expect(result.checks.redis.latencyMs).toBeGreaterThanOrEqual(40);
  });

  it('rejeição que chega depois do timeout não fica sem tratamento', async () => {
    const { database, redis } = fakeDependencies();
    redis.ping.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('tarde demais'));
          }, 30);
        }),
    );
    const result = await new HealthService(database as never, redis as never, 5).readiness();
    expect(result.checks.redis.status).toBe('down');
    // Espera a rejeição tardia acontecer; o Vitest falha o teste se ela não for tratada.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
