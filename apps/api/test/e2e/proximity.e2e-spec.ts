// E2E dos tokens de proximidade e do resolve (histórias 4.2 e 4.4 no servidor; ADR 0003; testes.md
// PROX-01, 02, 04, 05, 08, 20, 21, 25, 27 e A-17). As validades de 30 e 120 s correm no relógio de
// teste e no fake em memória do Redis (sem `sleep`).
import { eq, users } from '@sussurro/db';
import { block, connect, createUser, TEST_PASSWORD } from '@sussurro/db/testing';
import {
  ErrorResponseSchema,
  ProximityResolveResultSchema,
  ProximityTokenSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bearer, directSession, loginViaApi } from '../support/auth.js';
import {
  issueToken,
  person,
  pendingRequest,
  requestConnection,
  resolveTokens,
  UNKNOWN_TOKEN,
} from '../support/proximity.js';
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

const SECOND = 1_000;

function items(body: unknown) {
  return ProximityResolveResultSchema.parse(body).items;
}

describe('POST /proximity/tokens (4.2)', () => {
  it('[PROX-01] 16 caracteres base64url (12 bytes), válido por 30 s, renovar em 20 s; o Redis guarda só o hash', async () => {
    const helena = await person(t);
    const response = await t.http.post('/v1/proximity/tokens').set(helena.headers).expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = ProximityTokenSchema.parse(response.body);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(Buffer.from(body.token, 'base64url')).toHaveLength(12);
    expect(body.expiresAt).toBe(new Date(t.clock.now().getTime() + 30 * SECOND).toISOString());
    expect(body.renewInS).toBe(20);

    const entries = t.proximity.entries();
    expect(entries.map((entry) => entry.key.split(':').slice(0, 2).join(':')).sort()).toEqual([
      'prox:r',
      'prox:t',
      'prox:u',
      'prox:ut',
    ]);
    for (const entry of entries) {
      expect(entry.key).not.toContain(body.token);
      expect(entry.value).not.toContain(body.token);
    }
  });

  it('[PROX-08] [4.8] criador → 403 ACCOUNT_TYPE_NOT_ALLOWED; [X.3] e-mail não confirmado → 403', async () => {
    const creator = await createUser(t.database.db, {
      accountType: 'creator',
      emailVerifiedAt: new Date(),
    });
    const creatorHeaders = await directSession(t.app, creator);
    const denied = await t.http.post('/v1/proximity/tokens').set(creatorHeaders).expect(403);
    expect(ErrorResponseSchema.parse(denied.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
    const resolve = await t.http
      .post('/v1/proximity/resolve')
      .set(creatorHeaders)
      .send({ tokens: [UNKNOWN_TOKEN] })
      .expect(403);
    expect(ErrorResponseSchema.parse(resolve.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');

    const unverified = await createUser(t.database.db);
    const unverifiedHeaders = await directSession(t.app, unverified);
    const blocked = await t.http.post('/v1/proximity/tokens').set(unverifiedHeaders).expect(403);
    expect(ErrorResponseSchema.parse(blocked.body).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('[PROX-20] 7º token no minuto → 429 com Retry-After; por conta (outra pessoa segue normal); no minuto seguinte volta', async () => {
    const helena = await person(t);
    const caio = await person(t);
    for (let index = 0; index < 6; index++) {
      await issueToken(t, helena);
    }
    const limited = await t.http.post('/v1/proximity/tokens').set(helena.headers).expect(429);
    expect(ErrorResponseSchema.parse(limited.body).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await issueToken(t, caio);
    t.clock.advance(61 * SECOND);
    await issueToken(t, helena);
  });
});

describe('POST /proximity/resolve (4.4)', () => {
  it('[PROX-05] @, nome, avatar e alreadyConnected de cada token válido; sem o próprio, inválidos e vencidos', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    const marina = await person(t, 'marinac');
    await connect(t.database.db, helena.user, marina.user);
    const own = await issueToken(t, helena);
    const caioToken = await issueToken(t, caio);
    const marinaToken = await issueToken(t, marina);

    const response = await resolveTokens(t, helena, [
      UNKNOWN_TOKEN,
      caioToken,
      own,
      marinaToken,
      caioToken,
    ]).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(items(response.body)).toEqual([
      {
        token: caioToken,
        handle: 'caio.r',
        name: caio.user.name,
        avatarUrl: null,
        alreadyConnected: false,
      },
      {
        token: marinaToken,
        handle: 'marinac',
        name: marina.user.name,
        avatarUrl: null,
        alreadyConnected: true,
      },
    ]);
    // Nada além do que o schema declara (sem id, e-mail ou relações).
    expect(Object.keys((response.body as { items: object[] }).items[0]!).sort()).toEqual([
      'alreadyConnected',
      'avatarUrl',
      'handle',
      'name',
      'token',
    ]);
  });

  it('[PROX-05] lista de entrada limitada a 20 tokens; RSSI ou campo a mais → 400', async () => {
    const helena = await person(t);
    await issueToken(t, helena);
    const many = Array.from(
      { length: 21 },
      (_, index) => `AAAAAAAAAAAAAA${String(index).padStart(2, '0')}`,
    );
    await resolveTokens(t, helena, many).expect(400);
    await resolveTokens(t, helena, []).expect(400);
    await resolveTokens(t, helena, ['curto']).expect(400);
    await t.http
      .post('/v1/proximity/resolve')
      .set(helena.headers)
      .send({ tokens: [UNKNOWN_TOKEN], rssi: -50 })
      .expect(400);
  });

  it('[PROX-02] token aos 29 s resolve; aos 31 s, a resposta é igual à de um token inexistente', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const caioToken = await issueToken(t, caio);
    t.clock.advance(29 * SECOND);
    await issueToken(t, helena);
    expect(items((await resolveTokens(t, helena, [caioToken]).expect(200)).body)).toHaveLength(1);

    t.clock.advance(2 * SECOND);
    const expired = await resolveTokens(t, helena, [caioToken]).expect(200);
    const unknown = await resolveTokens(t, helena, [UNKNOWN_TOKEN]).expect(200);
    expect(expired.body).toEqual({ items: [] });
    expect(expired.text).toBe(unknown.text);
  });

  it('[PROX-04] sem a tela aberta (prox:u ausente ou vencido) → 409 PROXIMITY_SCREEN_CLOSED', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const caioToken = await issueToken(t, caio);
    const closed = await resolveTokens(t, helena, [caioToken]).expect(409);
    expect(ErrorResponseSchema.parse(closed.body).code).toBe('PROXIMITY_SCREEN_CLOSED');

    await issueToken(t, helena);
    await resolveTokens(t, helena, [caioToken]).expect(200);
    // A tela "fecha" sozinha se o app parar de renovar (30 s sem token novo).
    t.clock.advance(31 * SECOND);
    await resolveTokens(t, helena, [caioToken]).expect(409);
  });

  it('[PROX-25] dois tokens da mesma pessoa (rotação): uma linha, com o token mais recente', async () => {
    const helena = await person(t);
    const caio = await person(t, 'caio.r');
    await issueToken(t, helena);
    const older = await issueToken(t, caio);
    t.clock.advance(20 * SECOND);
    const newer = await issueToken(t, caio);
    await issueToken(t, helena);
    const list = items((await resolveTokens(t, helena, [older, newer]).expect(200)).body);
    expect(list).toEqual([expect.objectContaining({ handle: 'caio.r', token: newer })]);
    // Depois que o antigo vence, só o novo resolve.
    t.clock.advance(11 * SECOND);
    await issueToken(t, helena);
    expect(items((await resolveTokens(t, helena, [older]).expect(200)).body)).toEqual([]);
  });

  it('[PROX-05] [X.2] conta excluída e bloqueio em qualquer sentido não aparecem', async () => {
    const helena = await person(t);
    const blockedByHelena = await person(t);
    const blockedHelena = await person(t);
    const deleted = await person(t);
    await block(t.database.db, helena.user, blockedByHelena.user);
    await block(t.database.db, blockedHelena.user, helena.user);
    await issueToken(t, helena);
    const tokens = [
      await issueToken(t, blockedByHelena),
      await issueToken(t, blockedHelena),
      await issueToken(t, deleted),
    ];
    await t.database.db
      .update(users)
      .set({ deletedAt: t.clock.now() })
      .where(eq(users.id, deleted.user.id));
    expect(items((await resolveTokens(t, helena, tokens).expect(200)).body)).toEqual([]);
    // E o bloqueado também não vê quem o bloqueou.
    await issueToken(t, blockedByHelena);
    const helenaToken = await issueToken(t, helena);
    expect(
      items((await resolveTokens(t, blockedByHelena, [helenaToken]).expect(200)).body),
    ).toEqual([]);
  });

  it('[PROX-20] 31º resolve no minuto → 429; o resolve de outra pessoa não é afetado', async () => {
    const helena = await person(t);
    const caio = await person(t);
    await issueToken(t, helena);
    await issueToken(t, caio);
    for (let index = 0; index < 30; index++) {
      await resolveTokens(t, helena, [UNKNOWN_TOKEN]).expect(200);
    }
    await resolveTokens(t, helena, [UNKNOWN_TOKEN]).expect(429);
    await resolveTokens(t, caio, [UNKNOWN_TOKEN]).expect(200);
  });

  /**
   * 5 min de tela aberta com `people` pessoas por perto, cada uma renovando o token a cada 20 s em
   * momentos diferentes (aparelhos não sincronizados). `batchEveryS` = 0: o app resolve cada token
   * novo na hora; senão, junta os tokens novos numa chamada a cada `batchEveryS` segundos.
   */
  async function normalUse(people: number, batchEveryS: number) {
    const me = await person(t);
    const others = await Promise.all(Array.from({ length: people }, () => person(t)));
    const statuses: number[] = [];
    const resolved = new Set<string>();
    let pending: string[] = [];
    // Um segundo a mais no fim: a última leva de tokens (emitida aos 298 s) ainda é resolvida.
    for (let second = 0; second <= 5 * 60; second++) {
      if (second % 20 === 0) {
        await issueToken(t, me);
      }
      for (const [index, other] of others.entries()) {
        if ((second - index * 2) % 20 === 0 && second >= index * 2 && second < 5 * 60) {
          pending.push(await issueToken(t, other));
        }
      }
      const due = batchEveryS === 0 ? pending.length > 0 : second % batchEveryS === 0;
      if (due && pending.length > 0) {
        const tokens = batchEveryS === 0 ? pending.slice(0, 1) : pending;
        const response = await resolveTokens(t, me, tokens);
        statuses.push(response.status);
        for (const item of response.status === 200 ? items(response.body) : []) {
          resolved.add(item.token);
        }
        pending = pending.filter((token) => !tokens.includes(token));
      }
      t.clock.advance(SECOND);
    }
    return { statuses, resolved };
  }

  it('[A-17] [MAN-BLE-04] 3 pessoas por perto, 5 min, cada token novo resolvido na hora: nunca 429', async () => {
    const { statuses, resolved } = await normalUse(3, 0);
    expect(statuses.length).toBe(3 * 15);
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(resolved.size).toBe(3 * 15);
  });

  it('[A-17] 10 pessoas por perto, 5 min, em lote a cada 3 s (o contrato do app): nunca 429', async () => {
    const { statuses, resolved } = await normalUse(10, 3);
    expect(statuses.length).toBeGreaterThan(90);
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(resolved.size).toBe(10 * 15);
  });
});

describe('Redis fora e fim de sessão', () => {
  it('[PROX-21] Redis fora → 503 PROXIMITY_UNAVAILABLE em token, resolve, pedido e aceite; login, feed, perfil e logout seguem', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    const { request, fromToken } = await pendingRequest(t, helena, caio);

    t.proximity.down = true;
    const responses = [
      await t.http.post('/v1/proximity/tokens').set(helena.headers),
      await resolveTokens(t, helena, [UNKNOWN_TOKEN]),
      await requestConnection(t, helena, UNKNOWN_TOKEN),
      await t.http
        .post(`/v1/connections/requests/${request.id}/accept`)
        .set(caio.headers)
        .send({ observedToken: fromToken }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        code: 'PROXIMITY_UNAVAILABLE',
        message: 'Conectar está indisponível agora. Tente de novo em instantes.',
      });
    }

    const session = await loginViaApi(t.http, helena.user.email);
    const headers = bearer(session.tokens.accessToken);
    await t.http.get('/v1/feed?type=text').set(headers).expect(200);
    await t.http.get('/v1/me').set(headers).expect(200);
    await t.http.get('/v1/connections/requests/incoming').set(caio.headers).expect(200);
    await t.http.post('/v1/auth/logout').set(headers).expect(204);

    t.proximity.down = false;
    await issueToken(t, caio);
  });

  it('[PROX-27] logout e exclusão de conta: os tokens da conta deixam de resolver na hora', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const marina = await person(t);
    await issueToken(t, helena);
    const caioToken = await issueToken(t, caio);
    const marinaToken = await issueToken(t, marina);
    expect(items((await resolveTokens(t, helena, [caioToken, marinaToken])).body)).toHaveLength(2);

    await t.http.post('/v1/auth/logout').set(caio.headers).expect(204);
    const marinaSession = await loginViaApi(t.http, marina.user.email);
    await t.http
      .delete('/v1/me')
      .set(bearer(marinaSession.tokens.accessToken))
      .send({ password: TEST_PASSWORD })
      .expect(204);

    expect(
      items((await resolveTokens(t, helena, [caioToken, marinaToken]).expect(200)).body),
    ).toEqual([]);
    expect(t.proximity.entries().filter((entry) => entry.key.endsWith(caio.user.id))).toEqual([]);
  });
});
