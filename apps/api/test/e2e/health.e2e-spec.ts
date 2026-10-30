// E2E do health contra o AppModule real (F0-API-*). O /health/ready com Valkey real só roda com o
// compose: no modo TEST_DB=pglite o Redis é um dublê, e o teste seria um falso positivo.
import { isPgliteMode } from '@sussurro/db/testing';
import { ErrorResponseSchema, HealthReadySchema } from '@sussurro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../support/test-app.js';

describe('Health (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('F0-API-01: GET /health → 200', async () => {
    const response = await t.http.get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it.skipIf(isPgliteMode())(
    'F0-API-02: GET /health/ready → 200 com Postgres e Valkey reais up',
    async () => {
      const response = await t.http.get('/health/ready').expect(200);
      expect(HealthReadySchema.parse(response.body)).toMatchObject({
        status: 'ok',
        checks: { postgres: { status: 'up' }, redis: { status: 'up' } },
      });
    },
  );

  it('GET /health/ready verifica o banco de teste (PGlite ou Postgres)', async () => {
    const response = await t.http.get('/health/ready');
    expect(HealthReadySchema.parse(response.body).checks.postgres.status).toBe('up');
  });

  it('F0-API-05: GET /v1/nao-existe → 404 NOT_FOUND', async () => {
    const response = await t.http.get('/v1/nao-existe').expect(404);
    expect(ErrorResponseSchema.parse(response.body).code).toBe('NOT_FOUND');
  });
});
