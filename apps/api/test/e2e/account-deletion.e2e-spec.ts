// E2E da exclusão de conta (história 1.7, testes.md §6.7).
import { retiredHandles, users } from '@sussurro/db';
import { TEST_PASSWORD } from '@sussurro/db/testing';
import { ErrorResponseSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registerBody, signedInUser } from '../support/auth.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('DELETE /me', () => {
  it('[CONTA-01] senha errada → 401 INVALID_CREDENTIALS e nada muda', async () => {
    const { headers, session } = await signedInUser(t.http, t.database.db);
    const response = await t.http
      .delete('/v1/me')
      .set(headers)
      .send({ password: 'senha-errada-1' })
      .expect(401);
    expect(ErrorResponseSchema.parse(response.body).code).toBe('INVALID_CREDENTIALS');
    await t.http.get('/v1/me').set(headers).expect(200);
    await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.tokens.refreshToken })
      .expect(200);
  });

  it('[CONTA-01] sem senha → 400', async () => {
    const { headers } = await signedInUser(t.http, t.database.db);
    await t.http.delete('/v1/me').set(headers).send({}).expect(400);
  });

  it('[CONTA-01] senha certa → 204, deleted_at preenchido, sessões revogadas e o login falha igual', async () => {
    const { user, headers, session } = await signedInUser(t.http, t.database.db);
    const other = await t.http
      .post('/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    await t.http.delete('/v1/me').set(headers).send({ password: TEST_PASSWORD }).expect(204);

    const [row] = await t.database.db.select().from(users);
    expect(row?.deletedAt).toEqual(t.clock.now());
    for (const refreshToken of [
      session.tokens.refreshToken,
      (other.body as { tokens: { refreshToken: string } }).tokens.refreshToken,
    ]) {
      await t.http.post('/v1/auth/refresh').send({ refreshToken }).expect(401);
    }
    const login = await t.http
      .post('/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(401);
    expect(login.body).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'E-mail ou senha incorretos.',
    });
  });

  it('[CONTA-07] access token da conta excluída, ainda dentro dos 15 min → 401', async () => {
    const { headers } = await signedInUser(t.http, t.database.db);
    await t.http.delete('/v1/me').set(headers).send({ password: TEST_PASSWORD }).expect(204);
    const response = await t.http.get('/v1/me').set(headers).expect(401);
    expect(ErrorResponseSchema.parse(response.body).code).toBe('UNAUTHORIZED');
  });

  it('[CONTA-02] o perfil some na hora: GET /users/:handle → 404', async () => {
    const creator = await signedInUser(t.http, t.database.db, {
      handle: 'cozinhadabia',
      accountType: 'creator',
    });
    const person = await signedInUser(t.http, t.database.db);
    await t.http.get('/v1/users/cozinhadabia').set(person.headers).expect(200);

    await t.http
      .delete('/v1/me')
      .set(creator.headers)
      .send({ password: TEST_PASSWORD })
      .expect(204);

    const response = await t.http.get('/v1/users/cozinhadabia').set(person.headers).expect(404);
    expect(response.body).toEqual({ code: 'NOT_FOUND', message: 'Perfil não encontrado' });
  });

  it('[CONTA-06] o @ de conta excluída nunca é reutilizado (A-14); o e-mail fica livre', async () => {
    const { user, headers } = await signedInUser(t.http, t.database.db, { handle: 'helena' });
    await t.http.delete('/v1/me').set(headers).send({ password: TEST_PASSWORD }).expect(204);

    const sameHandle = await t.http
      .post('/v1/auth/register')
      .send(registerBody({ handle: 'helena' }))
      .expect(409);
    expect(ErrorResponseSchema.parse(sameHandle.body).code).toBe('HANDLE_TAKEN');

    // Mesmo depois do hard delete (a linha some de users), o @ continua aposentado.
    await t.database.db.delete(users);
    expect(await t.database.db.select().from(retiredHandles)).toEqual([
      { handle: 'helena', retiredAt: t.clock.now() },
    ]);
    t.clock.advance(60 * 60_000);
    const afterPurge = await t.http
      .post('/v1/auth/register')
      .send(registerBody({ handle: 'helena' }))
      .expect(409);
    expect(ErrorResponseSchema.parse(afterPurge.body).code).toBe('HANDLE_TAKEN');

    await t.http
      .post('/v1/auth/register')
      .send(registerBody({ email: user.email }))
      .expect(201);
  });

  it('o link de redefinição pedido antes da exclusão deixa de valer', async () => {
    const { user, headers } = await signedInUser(t.http, t.database.db);
    await t.http.post('/v1/auth/password/forgot').send({ email: user.email }).expect(202);
    const link = t.outbox.lastTo(user.email);
    await t.http.delete('/v1/me').set(headers).send({ password: TEST_PASSWORD }).expect(204);

    const token = new URL(link.link ?? '').searchParams.get('token');
    await t.http
      .post('/v1/auth/password/reset')
      .send({ token, password: 'nova-senha-forte-1' })
      .expect(400);
  });

  it('exclusão tem rate limit por conta (5 por minuto)', async () => {
    const { headers } = await signedInUser(t.http, t.database.db);
    for (let index = 0; index < 5; index++) {
      await t.http.delete('/v1/me').set(headers).send({ password: 'errada-123' }).expect(401);
    }
    await t.http.delete('/v1/me').set(headers).send({ password: TEST_PASSWORD }).expect(429);
    await t.http.get('/v1/me').set(headers).expect(200);
  });
});
