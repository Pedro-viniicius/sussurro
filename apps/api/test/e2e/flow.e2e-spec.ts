// Fluxo de ponta a ponta da Fase 1, na ordem do roteiro manual: cadastro → verificação (link do
// e-mail) → login → refresh → reuso detectado → GET /me → editar → esqueci a senha → excluir conta.
import { AuthSessionSchema, MeSchema, TokenPairSchema } from '@sussurro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CapturingEmailSender } from '../../src/testing/capturing-email-sender.js';
import { bearer } from '../support/auth.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe('fluxo completo da Fase 1', () => {
  it('cadastro → verificação → login → refresh → reuso → /me → editar → esqueci a senha → excluir', async () => {
    const email = 'helena@example.com';

    // 1. Cadastro (conta pessoal).
    const registered = AuthSessionSchema.parse(
      (
        await t.http
          .post('/v1/auth/register')
          .send({
            email,
            password: 'cafe-coado-42',
            handle: 'helena',
            name: 'Helena Souza',
            accountType: 'personal',
          })
          .expect(201)
      ).body,
    );
    expect(registered.user.emailVerified).toBe(false);

    // 2. Verificação pelo link que foi para o e-mail (no log, em dev).
    const verifyToken = CapturingEmailSender.tokenOf(t.outbox.lastTo(email));
    await t.http.post('/v1/auth/email/verify').send({ token: verifyToken }).expect(204);

    // 3. Login.
    t.clock.advance(1_000);
    const login = AuthSessionSchema.parse(
      (
        await t.http
          .post('/v1/auth/login')
          .send({ email, password: 'cafe-coado-42', deviceLabel: 'curl' })
          .expect(200)
      ).body,
    );
    expect(login.user).toMatchObject({ handle: 'helena', emailVerified: true });

    // 4. Refresh (rotação).
    t.clock.advance(1_000);
    const rotated = TokenPairSchema.parse(
      (
        await t.http
          .post('/v1/auth/refresh')
          .send({ refreshToken: login.tokens.refreshToken })
          .expect(200)
      ).body,
    );

    // 5. Reuso do refresh antigo depois de 20 s: 401 e a família inteira cai.
    t.clock.advance(21_000);
    await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.tokens.refreshToken })
      .expect(401);
    await t.http.post('/v1/auth/refresh').send({ refreshToken: rotated.refreshToken }).expect(401);

    // Novo login para seguir o fluxo.
    const session = AuthSessionSchema.parse(
      (await t.http.post('/v1/auth/login').send({ email, password: 'cafe-coado-42' }).expect(200))
        .body,
    );
    const headers = bearer(session.tokens.accessToken);

    // 6. GET /me.
    const me = MeSchema.parse((await t.http.get('/v1/me').set(headers).expect(200)).body);
    expect(me).toMatchObject({
      handle: 'helena',
      counts: { posts: 0, connections: 0, creators: 0 },
    });

    // 7. Editar nome e bio.
    const edited = MeSchema.parse(
      (
        await t.http
          .patch('/v1/me')
          .set(headers)
          .send({ name: 'Helena S.', bio: 'Arquiteta. Café coado.' })
          .expect(200)
      ).body,
    );
    expect(edited).toMatchObject({ name: 'Helena S.', bio: 'Arquiteta. Café coado.' });

    // 8. Esqueci a senha: link por e-mail, senha nova, sessões revogadas.
    await t.http.post('/v1/auth/password/forgot').send({ email }).expect(202);
    const resetToken = CapturingEmailSender.tokenOf(t.outbox.lastTo(email));
    await t.http
      .post('/v1/auth/password/reset')
      .send({ token: resetToken, password: 'nova-senha-forte-1' })
      .expect(204);
    await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.tokens.refreshToken })
      .expect(401);

    // 9. Excluir a conta (pede a senha nova).
    const final = AuthSessionSchema.parse(
      (
        await t.http
          .post('/v1/auth/login')
          .send({ email, password: 'nova-senha-forte-1' })
          .expect(200)
      ).body,
    );
    await t.http
      .delete('/v1/me')
      .set(bearer(final.tokens.accessToken))
      .send({ password: 'nova-senha-forte-1' })
      .expect(204);
    await t.http.get('/v1/me').set(bearer(final.tokens.accessToken)).expect(401);
    await t.http.post('/v1/auth/login').send({ email, password: 'nova-senha-forte-1' }).expect(401);
  });
});
