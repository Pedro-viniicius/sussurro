// E2E dos push tokens (história 6.4 no servidor; AUTH-12 com o push token). O token nunca sai numa
// resposta; só o dono mexe nele; o logout do aparelho o tira (o aparelho para de receber push).
import { eq, pushTokens, refreshTokens } from '@sussurro/db';
import { createUser, TEST_PASSWORD } from '@sussurro/db/testing';
import { MAX_PUSH_TOKENS_PER_ACCOUNT } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bearer, loginViaApi, signedInUser } from '../support/auth.js';
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

const IPHONE = 'ExponentPushToken[iphone-da-ana-0001]';
const ANDROID = 'ExponentPushToken[android-da-ana-002]';

function register(headers: Record<string, string>, expoToken: string, platform = 'ios') {
  return t.http.put('/v1/me/push-tokens').set(headers).send({ expoToken, platform });
}

async function tokensOf(userId: string) {
  return (await t.database.db.select().from(pushTokens).where(eq(pushTokens.userId, userId)))
    .map((row) => row.expoToken)
    .sort();
}

describe('PUT e DELETE /me/push-tokens (6.4)', () => {
  it('[6.4 CA1] registra o token para a conta, a plataforma e a sessão; repetir é idempotente; 204 sem corpo', async () => {
    const ana = await signedInUser(t.http, t.database.db);
    const response = await register(ana.headers, IPHONE).expect(204);
    expect(response.text).toBe('');
    await register(ana.headers, IPHONE, 'ios').expect(204);
    const rows = await t.database.db.select().from(pushTokens);
    expect(rows).toHaveLength(1);
    const [session] = await t.database.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, ana.user.id));
    expect(rows[0]).toMatchObject({
      userId: ana.user.id,
      expoToken: IPHONE,
      platform: 'ios',
      refreshFamilyId: session?.familyId,
      disabledAt: null,
    });
  });

  it('entrada inválida → 400 (formato do Expo, plataforma, campo a mais); o token não aparece no corpo do erro', async () => {
    const ana = await signedInUser(t.http, t.database.db);
    for (const body of [
      { expoToken: 'token-qualquer', platform: 'ios' },
      { expoToken: IPHONE, platform: 'web' },
      { expoToken: IPHONE, platform: 'ios', userId: ana.user.id },
      { platform: 'ios' },
    ]) {
      const response = await t.http
        .put('/v1/me/push-tokens')
        .set(ana.headers)
        .send(body)
        .expect(400);
      expect(response.text).not.toContain('iphone-da-ana');
    }
    await t.http.delete('/v1/me/push-tokens').set(ana.headers).send({}).expect(400);
    expect(await t.database.db.select().from(pushTokens)).toEqual([]);
  });

  it('[6.4 CA3] outra conta registrar ou apagar o token de Ana: 204 igual, e o token de Ana não muda', async () => {
    const ana = await signedInUser(t.http, t.database.db);
    const intrusa = await signedInUser(t.http, t.database.db);
    await register(ana.headers, IPHONE).expect(204);
    const [before] = await t.database.db.select().from(pushTokens);

    await register(intrusa.headers, IPHONE, 'android').expect(204);
    await t.http
      .delete('/v1/me/push-tokens')
      .set(intrusa.headers)
      .send({ expoToken: IPHONE })
      .expect(204);

    const [after] = await t.database.db.select().from(pushTokens);
    expect(after).toEqual(before);
    expect(await tokensOf(intrusa.user.id)).toEqual([]);
  });

  it('DELETE apaga só o token do próprio aparelho', async () => {
    const ana = await signedInUser(t.http, t.database.db);
    await register(ana.headers, IPHONE).expect(204);
    await register(ana.headers, ANDROID, 'android').expect(204);
    await t.http
      .delete('/v1/me/push-tokens')
      .set(ana.headers)
      .send({ expoToken: IPHONE })
      .expect(204);
    expect(await tokensOf(ana.user.id)).toEqual([ANDROID]);
  });

  it('[AUTH-12] [6.4 CA2] logout neste aparelho tira o token deste aparelho; o do outro aparelho continua; sair de todos tira todos', async () => {
    const user = await createUser(t.database.db);
    const iphone = await loginViaApi(t.http, user.email);
    const android = await loginViaApi(t.http, user.email);
    await register(bearer(iphone.tokens.accessToken), IPHONE).expect(204);
    await register(bearer(android.tokens.accessToken), ANDROID, 'android').expect(204);

    await t.http.post('/v1/auth/logout').set(bearer(iphone.tokens.accessToken)).expect(204);
    expect(await tokensOf(user.id)).toEqual([ANDROID]);

    await t.http.post('/v1/auth/logout-all').set(bearer(android.tokens.accessToken)).expect(204);
    expect(await tokensOf(user.id)).toEqual([]);
  });

  it('o aparelho troca de conta: depois do logout de Ana, Bia registra o mesmo token e passa a ser a dona', async () => {
    const ana = await signedInUser(t.http, t.database.db);
    const bia = await signedInUser(t.http, t.database.db);
    await register(ana.headers, IPHONE).expect(204);
    await t.http.post('/v1/auth/logout').set(ana.headers).expect(204);
    await register(bia.headers, IPHONE).expect(204);
    expect(await tokensOf(bia.user.id)).toEqual([IPHONE]);
    expect(await tokensOf(ana.user.id)).toEqual([]);
  });

  it('sessão de Ana encerrada sem o logout chegar (revogada ou vencida): o token passa para quem registra', async () => {
    const ana = await signedInUser(t.http, t.database.db);
    const bia = await signedInUser(t.http, t.database.db);
    await register(ana.headers, IPHONE).expect(204);
    await t.database.db
      .update(refreshTokens)
      .set({ revokedAt: t.clock.now() })
      .where(eq(refreshTokens.userId, ana.user.id));
    await register(bia.headers, IPHONE).expect(204);
    expect(await tokensOf(bia.user.id)).toEqual([IPHONE]);
  });

  it('exclusão de conta remove todos os tokens', async () => {
    const ana = await signedInUser(t.http, t.database.db);
    await register(ana.headers, IPHONE).expect(204);
    await register(ana.headers, ANDROID, 'android').expect(204);
    await t.http.delete('/v1/me').set(ana.headers).send({ password: TEST_PASSWORD }).expect(204);
    expect(await t.database.db.select().from(pushTokens)).toEqual([]);
  });

  it(`no máximo ${String(MAX_PUSH_TOKENS_PER_ACCOUNT)} tokens por conta: o mais antigo sai`, async () => {
    const ana = await signedInUser(t.http, t.database.db);
    for (let index = 0; index < MAX_PUSH_TOKENS_PER_ACCOUNT + 2; index++) {
      t.clock.advance(1_000);
      await register(
        ana.headers,
        `ExponentPushToken[aparelho-${String(index).padStart(2, '0')}]`,
      ).expect(204);
    }
    const tokens = await tokensOf(ana.user.id);
    expect(tokens).toHaveLength(MAX_PUSH_TOKENS_PER_ACCOUNT);
    expect(tokens).not.toContain('ExponentPushToken[aparelho-00]');
    expect(tokens).not.toContain('ExponentPushToken[aparelho-01]');
  });

  it('refresh reapresentado depois da janela (roubo provável): a família e o push token dela saem', async () => {
    const ana = await signedInUser(t.http, t.database.db);
    await register(ana.headers, IPHONE).expect(204);
    const rotated = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: ana.session.tokens.refreshToken })
      .expect(200);
    expect(rotated.status).toBe(200);
    t.clock.advance(60_000);
    await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: ana.session.tokens.refreshToken })
      .expect(401);
    expect(await tokensOf(ana.user.id)).toEqual([]);
  });
});
