// Rotas de desenvolvimento (D15; história 4.11; testes.md PROX-30). `POST /v1/dev/simulate-request`
// só existe com NODE_ENV=development: em `test` e `production` o módulo nem é registrado.
import { connectionRequests, connections, eq, users } from '@sussurro/db';
import { block, seedDatabase, TEST_PASSWORD_HASH } from '@sussurro/db/testing';
import {
  ErrorResponseSchema,
  IncomingConnectionRequestsSchema,
  SimulatedConnectionRequestSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { devModules } from '../../src/app.module.js';
import { DevModule } from '../../src/modules/dev/dev.module.js';
import { directUser } from '../support/auth.js';
import { acceptRequest, issueToken, person, parseRequest } from '../support/proximity.js';
import { listRoutes, routeKey } from '../support/routes.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const ROUTE = 'POST /v1/dev/simulate-request';

describe('[PROX-30] fora de desenvolvimento a rota não existe', () => {
  it('[PROX-30] devModules só inclui o DevModule com NODE_ENV=development', () => {
    expect(devModules({ NODE_ENV: 'development' })).toEqual([DevModule]);
    expect(devModules({ NODE_ENV: 'test' })).toEqual([]);
    expect(devModules({ NODE_ENV: 'production' })).toEqual([]);
  });

  for (const NODE_ENV of ['production', 'test'] as const) {
    it(`[PROX-30] NODE_ENV=${NODE_ENV}: a rota não está registrada e responde 404, com ou sem sessão`, async () => {
      const t = await createTestApp({
        env: {
          NODE_ENV,
          // Produção exige SES e o e-mail da moderação (a mídia já sai pelo CloudFront no teste).
          ...(NODE_ENV === 'production'
            ? { EMAIL_SENDER: 'ses', MODERATION_EMAIL: 'moderacao@example.com' }
            : {}),
        },
      });
      try {
        expect(listRoutes(t.app).map(routeKey)).not.toContain(ROUTE);
        expect(listRoutes(t.app).some((route) => route.path.startsWith('/v1/dev'))).toBe(false);
        const someone = await person(t);
        const anonymous = await t.http.post('/v1/dev/simulate-request').send({});
        const signedIn = await t.http
          .post('/v1/dev/simulate-request')
          .set(someone.headers)
          .send({});
        const unknown = await t.http.post('/v1/rota-que-nao-existe').set(someone.headers).send({});
        expect([anonymous.status, signedIn.status]).toEqual([404, 404]);
        expect(signedIn.body).toEqual({
          ...(unknown.body as object),
          message: expect.any(String) as unknown,
        });
        expect(ErrorResponseSchema.parse(signedIn.body).code).toBe('NOT_FOUND');
      } finally {
        await t.close();
      }
    });
  }
});

describe('[4.11] simular um pedido recebido (NODE_ENV=development)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ env: { NODE_ENV: 'development' } });
    await seedDatabase(t.database.db, { passwordHash: TEST_PASSWORD_HASH, now: t.clock.now() });
  });

  afterAll(async () => {
    await t.close();
  });

  it('[4.11 CA1] a persona do seed (@lucasf) pede conexão para a conta logada: aparece na caixa de entrada e o aceite com o token devolvido conecta', async () => {
    const me = await person(t, 'testadora');
    expect(listRoutes(t.app).map(routeKey)).toContain(ROUTE);
    const response = await t.http
      .post('/v1/dev/simulate-request')
      .set(me.headers)
      .send({})
      .expect(201);
    const simulated = SimulatedConnectionRequestSchema.parse(response.body);
    expect(simulated.request).toMatchObject({
      direction: 'incoming',
      status: 'pending',
      method: 'ble',
      other: { handle: 'lucasf', name: 'Lucas Ferreira' },
      expiresInS: 120,
    });
    const inbox = IncomingConnectionRequestsSchema.parse(
      (await t.http.get('/v1/connections/requests/incoming').set(me.headers).expect(200)).body,
    );
    expect(inbox.items.map((item) => item.id)).toEqual([simulated.request.id]);

    await issueToken(t, me);
    const accepted = await acceptRequest(t, me, simulated.request.id, simulated.observedToken);
    expect(accepted.status).toBe(200);
    expect(parseRequest(accepted).status).toBe('accepted');
    expect(await t.database.db.select().from(connections)).toHaveLength(
      // As 2 conexões do seed e a nova.
      3,
    );

    // Já conectados: 409; com @tomas e QR, outro pedido.
    await t.http.post('/v1/dev/simulate-request').set(me.headers).send({}).expect(409);
    const qr = await t.http
      .post('/v1/dev/simulate-request')
      .set(me.headers)
      .send({ from: '@Tomas', method: 'qr' })
      .expect(201);
    expect(SimulatedConnectionRequestSchema.parse(qr.body).request).toMatchObject({
      method: 'qr',
      other: { handle: 'tomas' },
    });
  });

  it('[4.11] persona fora da lista ou campo a mais → 400; criador → 403 (guard); com bloqueio → 409, nada gravado', async () => {
    const me = await person(t);
    for (const body of [{ from: 'helena' }, { from: 'lucasf', extra: true }]) {
      await t.http.post('/v1/dev/simulate-request').set(me.headers).send(body).expect(400);
    }
    const creator = await directUser(t.app, t.database.db, { accountType: 'creator' });
    const denied = await t.http
      .post('/v1/dev/simulate-request')
      .set(creator.headers)
      .send({})
      .expect(403);
    expect(ErrorResponseSchema.parse(denied.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');

    const [lucas] = await t.database.db.select().from(users).where(eq(users.handle, 'lucasf'));
    await block(t.database.db, me.user, lucas!);
    const before = await t.database.db.select().from(connectionRequests);
    await t.http.post('/v1/dev/simulate-request').set(me.headers).send({}).expect(409);
    expect(await t.database.db.select().from(connectionRequests)).toHaveLength(before.length);
  });

  it('[4.11] sem o seed, a persona não existe → 404 com a dica de rodar o seed', async () => {
    const fresh = await createTestApp({ env: { NODE_ENV: 'development' } });
    try {
      const someone = await person(fresh);
      const missing = await fresh.http
        .post('/v1/dev/simulate-request')
        .set(someone.headers)
        .send({})
        .expect(404);
      expect(ErrorResponseSchema.parse(missing.body).message).toContain('pnpm db:seed');
    } finally {
      await fresh.close();
    }
  });
});
