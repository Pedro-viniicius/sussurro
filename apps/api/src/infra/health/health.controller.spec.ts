import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ErrorResponseSchema, HealthLiveSchema, HealthReadySchema } from '@sussurro/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app.setup.js';
import { fakeDependencies, testEnv } from '../../testing/test-env.js';
import { DATABASE } from '../database/database.providers.js';
import { REDIS } from '../redis/redis.providers.js';

// Sobe o app HTTP real (filtro, prefixo, logger) com Postgres e Redis trocados por dublês.
// Não precisa de Docker; o e2e contra o compose fica em test/health.e2e-spec.ts.
describe('HealthController (HTTP, com dublês)', () => {
  let app: NestExpressApplication;
  let deps: ReturnType<typeof fakeDependencies>;

  beforeEach(async () => {
    deps = fakeDependencies();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(testEnv())] })
      .overrideProvider(DATABASE)
      .useValue(deps.database)
      .overrideProvider(REDIS)
      .useValue(deps.redis)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(), testEnv());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('F0-API-01: GET /health responde 200 { status: "ok" } sem tocar nas dependências', async () => {
    deps.redis.ping.mockRejectedValue(new Error('fora'));
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(HealthLiveSchema.safeParse(response.body).success).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(deps.redis.ping).not.toHaveBeenCalled();
    expect(deps.database.db.execute).not.toHaveBeenCalled();
  });

  it('F0-API-02: GET /health/ready responde 200 com tudo up', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(HealthReadySchema.parse(response.body)).toMatchObject({
      status: 'ok',
      checks: { postgres: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('F0-API-03: GET /health/ready responde 503 com Redis down', async () => {
    deps.redis.ping.mockRejectedValue(new Error('ECONNREFUSED'));
    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(HealthReadySchema.parse(response.body)).toMatchObject({
      status: 'error',
      checks: { postgres: { status: 'up' }, redis: { status: 'down' } },
    });
  });

  it('F0-API-04: GET /health/ready responde 503 com Postgres down', async () => {
    deps.database.db.execute.mockRejectedValue(new Error('ECONNREFUSED'));
    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(response.body).toMatchObject({
      status: 'error',
      checks: { postgres: { status: 'down' } },
    });
  });

  it('o health fica fora do prefixo /v1', async () => {
    await request(app.getHttpServer()).get('/v1/health').expect(404);
  });

  it('F0-API-05: rota inexistente responde 404 { code: "NOT_FOUND" } sem stack', async () => {
    const response = await request(app.getHttpServer()).get('/v1/nao-existe').expect(404);
    expect(ErrorResponseSchema.parse(response.body).code).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toMatch(/at .+\.js/);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
