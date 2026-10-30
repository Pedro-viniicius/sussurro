// E2E de "esqueci a senha" (história 1.10) e confirmação de e-mail (X.3), decididos no D6.
import { createUser, TEST_PASSWORD } from '@sussurro/db/testing';
import { ErrorResponseSchema, MeSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CapturingEmailSender } from '../../src/testing/capturing-email-sender.js';
import {
  bearer,
  loginViaApi,
  registerViaApi,
  signedInUser,
  VALID_PASSWORD,
} from '../support/auth.js';
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

const NEW_PASSWORD = 'nova-senha-forte-1';

function errorCode(body: unknown): string {
  return ErrorResponseSchema.parse(body).code;
}

describe('esqueci a senha (1.10)', () => {
  it('CA1 (1.10): a resposta é a mesma para e-mail cadastrado e inexistente; só o real recebe o link', async () => {
    await createUser(t.database.db, { email: 'helena@example.com' });
    const known = await t.http
      .post('/v1/auth/password/forgot')
      .send({ email: 'Helena@Example.com' })
      .expect(202);
    const unknown = await t.http
      .post('/v1/auth/password/forgot')
      .send({ email: 'ninguem@example.com' })
      .expect(202);
    expect(known.body).toEqual(unknown.body);
    expect(known.text).toBe('');
    expect(t.outbox.sent.map((message) => message.to)).toEqual(['helena@example.com']);
    expect(t.outbox.sent[0]?.link).toMatch(/^sussurro:\/\/redefinir-senha\?token=/);
  });

  it('CA2 (1.10): o link troca a senha e revoga todas as sessões; a senha antiga para de valer', async () => {
    const user = await createUser(t.database.db, { email: 'helena@example.com' });
    const before = await loginViaApi(t.http, user.email);

    await t.http.post('/v1/auth/password/forgot').send({ email: user.email }).expect(202);
    const token = CapturingEmailSender.tokenOf(t.outbox.lastTo(user.email));
    await t.http
      .post('/v1/auth/password/reset')
      .send({ token, password: NEW_PASSWORD })
      .expect(204);

    await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: before.tokens.refreshToken })
      .expect(401);
    await t.http
      .post('/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(401);
    const after = await loginViaApi(t.http, user.email, NEW_PASSWORD);
    // Abrir o link do e-mail prova que o endereço é da pessoa.
    expect(after.user.emailVerified).toBe(true);
  });

  it('CA2 (1.10): link usado pela segunda vez, vencido (1 h) ou substituído por um novo → 400 INVALID_TOKEN', async () => {
    const user = await createUser(t.database.db);
    await t.http.post('/v1/auth/password/forgot').send({ email: user.email }).expect(202);
    const first = CapturingEmailSender.tokenOf(t.outbox.lastTo(user.email));
    await t.http
      .post('/v1/auth/password/reset')
      .send({ token: first, password: NEW_PASSWORD })
      .expect(204);
    const reused = await t.http
      .post('/v1/auth/password/reset')
      .send({ token: first, password: 'outra-senha-forte-2' })
      .expect(400);
    expect(errorCode(reused.body)).toBe('INVALID_TOKEN');

    await t.http.post('/v1/auth/password/forgot').send({ email: user.email }).expect(202);
    const expired = CapturingEmailSender.tokenOf(t.outbox.lastTo(user.email));
    t.clock.advance(60 * 60_000);
    const late = await t.http
      .post('/v1/auth/password/reset')
      .send({ token: expired, password: NEW_PASSWORD })
      .expect(400);
    expect(errorCode(late.body)).toBe('INVALID_TOKEN');

    await t.http.post('/v1/auth/password/forgot').send({ email: user.email }).expect(202);
    const replaced = CapturingEmailSender.tokenOf(t.outbox.lastTo(user.email));
    await t.http.post('/v1/auth/password/forgot').send({ email: user.email }).expect(202);
    await t.http
      .post('/v1/auth/password/reset')
      .send({ token: replaced, password: NEW_PASSWORD })
      .expect(400);
  });

  it('[AUTH-02] senha nova fraca → 400 WEAK_PASSWORD e o link continua valendo', async () => {
    const user = await createUser(t.database.db);
    await t.http.post('/v1/auth/password/forgot').send({ email: user.email }).expect(202);
    const token = CapturingEmailSender.tokenOf(t.outbox.lastTo(user.email));
    const weak = await t.http
      .post('/v1/auth/password/reset')
      .send({ token, password: 'senha123' })
      .expect(400);
    expect(errorCode(weak.body)).toBe('WEAK_PASSWORD');
    await t.http
      .post('/v1/auth/password/reset')
      .send({ token, password: NEW_PASSWORD })
      .expect(204);
  });

  it('rate limit: 4º pedido para o mesmo e-mail na hora → 429', async () => {
    const user = await createUser(t.database.db);
    for (let index = 0; index < 3; index++) {
      await t.http.post('/v1/auth/password/forgot').send({ email: user.email }).expect(202);
    }
    const response = await t.http
      .post('/v1/auth/password/forgot')
      .send({ email: user.email })
      .expect(429);
    expect(errorCode(response.body)).toBe('RATE_LIMITED');
  });
});

describe('confirmação de e-mail (X.3)', () => {
  it('CA1 (X.3): o link do cadastro confirma o e-mail; reutilizado → 400', async () => {
    const session = await registerViaApi(t.http, { email: 'nova@example.com' });
    const token = CapturingEmailSender.tokenOf(t.outbox.lastTo('nova@example.com'));

    await t.http.post('/v1/auth/email/verify').send({ token }).expect(204);
    const me = await t.http.get('/v1/me').set(bearer(session.tokens.accessToken)).expect(200);
    expect(MeSchema.parse(me.body).emailVerified).toBe(true);

    const reused = await t.http.post('/v1/auth/email/verify').send({ token }).expect(400);
    expect(errorCode(reused.body)).toBe('INVALID_TOKEN');
  });

  it('CA1 (X.3): link vencido (24 h) → 400 INVALID_TOKEN', async () => {
    await registerViaApi(t.http, { email: 'nova@example.com' });
    const token = CapturingEmailSender.tokenOf(t.outbox.lastTo('nova@example.com'));
    t.clock.advance(24 * 60 * 60_000);
    const response = await t.http.post('/v1/auth/email/verify').send({ token }).expect(400);
    expect(errorCode(response.body)).toBe('INVALID_TOKEN');
  });

  it('reenviar invalida o link anterior; conta já confirmada não recebe outro; 4º reenvio na hora → 429', async () => {
    const session = await registerViaApi(t.http, { email: 'nova@example.com' });
    const headers = bearer(session.tokens.accessToken);
    const first = CapturingEmailSender.tokenOf(t.outbox.lastTo('nova@example.com'));

    await t.http.post('/v1/me/email/verification').set(headers).expect(202);
    const second = CapturingEmailSender.tokenOf(t.outbox.lastTo('nova@example.com'));
    expect(second).not.toBe(first);
    await t.http.post('/v1/auth/email/verify').send({ token: first }).expect(400);

    await t.http.post('/v1/me/email/verification').set(headers).expect(202);
    await t.http.post('/v1/me/email/verification').set(headers).expect(202);
    await t.http.post('/v1/me/email/verification').set(headers).expect(429);

    t.clock.advance(60 * 60_000 + 1);
    const third = CapturingEmailSender.tokenOf(t.outbox.lastTo('nova@example.com'));
    await t.http.post('/v1/auth/email/verify').send({ token: third }).expect(204);
    const sentBefore = t.outbox.sent.length;
    // Depois de 1 h o access token venceu: entra de novo.
    const again = await loginViaApi(t.http, 'nova@example.com', VALID_PASSWORD);
    await t.http
      .post('/v1/me/email/verification')
      .set(bearer(again.tokens.accessToken))
      .expect(202);
    expect(t.outbox.sent).toHaveLength(sentBefore);
  });

  it('token desconhecido → 400', async () => {
    await signedInUser(t.http, t.database.db);
    await t.http.post('/v1/auth/email/verify').send({ token: 'qualquer' }).expect(400);
    await t.http.post('/v1/auth/email/verify').send({}).expect(400);
  });
});
