import { describe, expect, it } from 'vitest';

import { HealthLiveSchema, HealthReadySchema } from './health.ts';

describe('HealthLiveSchema', () => {
  it('aceita { status: "ok" } e rejeita outros valores', () => {
    expect(HealthLiveSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(HealthLiveSchema.safeParse({ status: 'error' }).success).toBe(false);
  });
});

describe('HealthReadySchema', () => {
  const up = { status: 'up', latencyMs: 3 } as const;
  const down = { status: 'down', latencyMs: 1000 } as const;

  it('aceita tudo up', () => {
    expect(
      HealthReadySchema.safeParse({ status: 'ok', checks: { postgres: up, redis: up } }).success,
    ).toBe(true);
  });

  it('aceita erro com dependência down', () => {
    expect(
      HealthReadySchema.safeParse({ status: 'error', checks: { postgres: up, redis: down } })
        .success,
    ).toBe(true);
  });

  it('rejeita check sem latência ou com status desconhecido', () => {
    expect(
      HealthReadySchema.safeParse({
        status: 'ok',
        checks: { postgres: { status: 'up' }, redis: up },
      }).success,
    ).toBe(false);
    expect(
      HealthReadySchema.safeParse({
        status: 'ok',
        checks: { postgres: { status: 'maybe', latencyMs: 1 }, redis: up },
      }).success,
    ).toBe(false);
  });
});
