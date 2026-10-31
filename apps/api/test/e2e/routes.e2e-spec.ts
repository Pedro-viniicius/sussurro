// Regras transversais das rotas: 401 sem token (PERM-18), schema de resposta obrigatório e
// filtrado (PERM-12), guard de tipo de conta (PERM-05) e erro de FK virando 403 (história 1.8).
import { Controller, Get, Post } from '@nestjs/common';
import { refreshTokens } from '@sussurro/db';
import { createUser } from '@sussurro/db/testing';
import { ErrorResponseSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Public, RequireAccountType } from '../../src/common/auth/decorators.js';
import { ResponseSchema } from '../../src/common/http/response-schema.js';
import { directUser, signedInUser } from '../support/auth.js';
import { concretePath, listRoutes, routeKey } from '../support/routes.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/**
 * Módulos em que toda rota é só de conta pessoal (PERM-05). Fase 4: `ConnectionsModule` e
 * `ProximityModule` (4.8 CA1, PROX-08).
 */
const PERSONAL_ONLY_MODULES = [
  'FeedModule',
  'FollowsModule',
  'ConnectionsModule',
  'ProximityModule',
];

/**
 * Todas as rotas com `@RequireAccountType('personal')` (PERM-05, A-06): feed, busca, seguir, as
 * listas próprias de conexões e seguidos, curtir e (Fase 4) proximidade, pedidos de conexão e
 * desfazer conexão. Uma rota que perde ou ganha o guard muda esta lista e precisa de revisão.
 */
const PERSONAL_ONLY_ROUTES = [
  'POST /v1/proximity/tokens',
  'POST /v1/proximity/touches',
  'POST /v1/proximity/resolve',
  'POST /v1/connections/requests',
  'GET /v1/connections/requests/incoming',
  'GET /v1/connections/requests/:id',
  'POST /v1/connections/requests/:id/accept',
  'POST /v1/connections/requests/:id/decline',
  'DELETE /v1/connections/requests/:id',
  'DELETE /v1/connections/:handle',
  'GET /v1/feed',
  'GET /v1/search/creators',
  'PUT /v1/creators/:handle/follow',
  'DELETE /v1/creators/:handle/follow',
  'GET /v1/me/connections',
  'GET /v1/me/following',
  'PUT /v1/posts/:id/like',
  'DELETE /v1/posts/:id/like',
].sort();

/** As únicas rotas abertas sem token (testes.md PERM-18, atualizado com o D6 na Fase 1). */
const PUBLIC_ROUTES = [
  'GET /health',
  'GET /health/ready',
  'POST /v1/auth/register',
  'POST /v1/auth/login',
  'POST /v1/auth/refresh',
  'POST /v1/auth/password/forgot',
  'POST /v1/auth/password/reset',
  'POST /v1/auth/email/verify',
].sort();

describe('rotas de produção', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('[PERM-18] só a lista revisada de rotas é pública', () => {
    const publicRoutes = listRoutes(t.app)
      .filter((route) => route.isPublic)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(publicRoutes).toEqual(PUBLIC_ROUTES);
  });

  it('[PERM-18] toda rota protegida responde 401 sem token', async () => {
    const protectedRoutes = listRoutes(t.app).filter((route) => !route.isPublic);
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(6);
    for (const route of protectedRoutes) {
      const response = await t.http[
        route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete' | 'put'
      ](concretePath(route.path)).send({});
      expect({ route: `${route.method} ${route.path}`, status: response.status }).toEqual({
        route: `${route.method} ${route.path}`,
        status: 401,
      });
      expect(ErrorResponseSchema.parse(response.body).code).toBe('UNAUTHORIZED');
    }
  });

  it('[PERM-05] [PROX-08] feed, busca, seguir, listas, proximidade e conexões exigem @RequireAccountType("personal"); o criador recebe 403 em todas', async () => {
    const routes = listRoutes(t.app);
    // O teste falha se uma rota destes módulos não tiver o guard.
    const moduleRoutes = routes.filter((route) => PERSONAL_ONLY_MODULES.includes(route.module));
    expect(moduleRoutes.map(routeKey).sort()).toEqual(
      [
        'DELETE /v1/creators/:handle/follow',
        'GET /v1/feed',
        'GET /v1/search/creators',
        'PUT /v1/creators/:handle/follow',
        'POST /v1/proximity/tokens',
        // ADR 0012: o relato do encosto (PROX-34).
        'POST /v1/proximity/touches',
        'POST /v1/proximity/resolve',
        'POST /v1/connections/requests',
        'GET /v1/connections/requests/incoming',
        'GET /v1/connections/requests/:id',
        'POST /v1/connections/requests/:id/accept',
        'POST /v1/connections/requests/:id/decline',
        'DELETE /v1/connections/requests/:id',
        'DELETE /v1/connections/:handle',
      ].sort(),
    );
    for (const route of moduleRoutes) {
      expect({ route: routeKey(route), guard: route.requiredAccountType }).toEqual({
        route: routeKey(route),
        guard: 'personal',
      });
    }
    expect(
      routes
        .filter((route) => route.requiredAccountType === 'personal')
        .map(routeKey)
        .sort(),
    ).toEqual(PERSONAL_ONLY_ROUTES);

    const creator = await directUser(t.app, t.database.db, { accountType: 'creator' });
    for (const route of routes.filter((item) => item.requiredAccountType === 'personal')) {
      const response = await t.http[
        route.method.toLowerCase() as 'get' | 'put' | 'delete' | 'post'
      ](concretePath(route.path))
        .set(creator.headers)
        .send({});
      expect({ route: routeKey(route), status: response.status }).toEqual({
        route: routeKey(route),
        status: 403,
      });
      expect(ErrorResponseSchema.parse(response.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
    }
  });

  it('[PERM-12] toda rota registrada declara o schema de resposta', () => {
    const withoutSchema = listRoutes(t.app)
      .filter((route) => !route.hasResponseSchema)
      .map((route) => `${route.controller.name}.${route.handlerName}`);
    expect(withoutSchema).toEqual([]);
  });
});

@Controller('teste')
class TestOnlyController {
  /** Sem @ResponseSchema: precisa falhar fechado. */
  @Public()
  @Get('sem-schema')
  withoutSchema() {
    return { ok: true };
  }

  /** O "service" devolve um campo a mais, que não pode sair. */
  @Public()
  @Get('campo-extra')
  @ResponseSchema(z.object({ handle: z.string() }))
  extraField() {
    return { handle: 'helena', passwordHash: '$argon2id$segredo' };
  }

  /** Devolve algo fora do schema declarado. */
  @Public()
  @Get('saida-invalida')
  @ResponseSchema(z.object({ handle: z.string() }))
  invalidOutput() {
    return { handle: 42 };
  }

  @Get('so-pessoal')
  @RequireAccountType('personal')
  @ResponseSchema(z.object({ ok: z.literal(true) }))
  personalOnly() {
    return { ok: true as const };
  }
}

describe('interceptor de resposta e guards (história 1.8)', () => {
  let t: TestApp;

  @Controller('teste-fk')
  class ForeignKeyController {
    /** Grava uma sessão de usuário inexistente: o banco recusa pela FK. */
    @Public()
    @Post()
    @ResponseSchema(z.object({ ok: z.boolean() }))
    async insertOrphan() {
      await t.database.db.insert(refreshTokens).values({
        userId: '01a189e0-af57-7000-85fe-2054e618fea6',
        familyId: '01a189e0-af57-7000-85fe-2054e618fea6',
        tokenHash: new Uint8Array(32).fill(9),
        expiresAt: new Date(Date.now() + 60_000),
      });
      return { ok: true };
    }
  }

  beforeAll(async () => {
    t = await createTestApp({ controllers: [TestOnlyController, ForeignKeyController] });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
  });

  it('[PERM-12] rota sem schema declarado → 500 INTERNAL_ERROR (falha fechada)', async () => {
    const response = await t.http.get('/v1/teste/sem-schema').expect(500);
    expect(response.body).toEqual({ code: 'INTERNAL_ERROR', message: 'Erro interno' });
  });

  it('[PERM-12] campo não declarado no schema não sai (ex.: passwordHash)', async () => {
    const response = await t.http.get('/v1/teste/campo-extra').expect(200);
    expect(response.body).toEqual({ handle: 'helena' });
  });

  it('[PERM-12] saída fora do schema → 500, sem vazar o conteúdo', async () => {
    const response = await t.http.get('/v1/teste/saida-invalida').expect(500);
    expect(response.body).toEqual({ code: 'INTERNAL_ERROR', message: 'Erro interno' });
  });

  it('[PERM-05] rota com @RequireAccountType("personal"): criador → 403 ACCOUNT_TYPE_NOT_ALLOWED', async () => {
    const creator = await signedInUser(t.http, t.database.db, { accountType: 'creator' });
    const denied = await t.http.get('/v1/teste/so-pessoal').set(creator.headers).expect(403);
    expect(ErrorResponseSchema.parse(denied.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');

    const person = await signedInUser(t.http, t.database.db, { accountType: 'personal' });
    await t.http.get('/v1/teste/so-pessoal').set(person.headers).expect(200);
    await t.http.get('/v1/teste/so-pessoal').expect(401);
  });

  it('CA4 (1.8): erro de FK do banco vira 403, nunca 500', async () => {
    await createUser(t.database.db);
    const response = await t.http.post('/v1/teste-fk').send({}).expect(403);
    expect(ErrorResponseSchema.parse(response.body).code).toBe('FORBIDDEN');
  });
});
