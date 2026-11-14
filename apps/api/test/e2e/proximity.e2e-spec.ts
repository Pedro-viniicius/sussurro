// E2E dos tokens de proximidade e do resolve do código lido por QR ou NFC (histórias 4.2 e 4.4 no
// servidor; ADR 0003 e ADR 0013; testes.md PROX-01, 02, 04, 05, 08, 20, 21, 25, 27, PROX-31 e
// A-17). As validades de 30 e 120 s correm no relógio de teste e no fake em memória do Redis (sem
// `sleep`). (ADR 0013) O encosto por Bluetooth (`POST /proximity/touches`) saiu: a rota responde
// o 404 de qualquer rota desconhecida.
import { eq, users } from '@sussurro/db';
import { block, connect, createUser, TEST_PASSWORD } from '@sussurro/db/testing';
import {
  ErrorResponseSchema,
  ProximityResolveResultSchema,
  ProximityTokenSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  generateProximityToken,
  hashProximityToken,
} from '../../src/modules/proximity/proximity-token.js';
import { ProximityRepository } from '../../src/modules/proximity/proximity.repository.js';
import { bearer, directSession, loginViaApi } from '../support/auth.js';
import {
  issueToken,
  issueTokens,
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
  it('[PROX-01] [PROX-31] um token só (ADR 0013: o mesmo no QR e no NFC), 16 caracteres base64url (12 bytes), válido por 30 s, renovar em 20 s; o Redis guarda só o hash, sem canal', async () => {
    const helena = await person(t);
    const response = await t.http.post('/v1/proximity/tokens').set(helena.headers).expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body as object).sort()).toEqual(['expiresAt', 'renewInS', 'token']);
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
    // O registro guarda só dono e emissão.
    const records = entries
      .filter((entry) => entry.key.startsWith('prox:t:'))
      .map((entry) => JSON.parse(entry.value) as unknown);
    expect(records).toEqual([{ uid: helena.user.id, iat: t.clock.now().getTime() }]);
  });

  it('[PROX-30] (ADR 0013) POST /proximity/touches não existe mais: o 404 de qualquer rota desconhecida', async () => {
    const helena = await person(t);
    await issueToken(t, helena);
    const unknown = await t.http.post('/v1/rota-que-nao-existe').set(helena.headers).send({});
    const touches = await t.http
      .post('/v1/proximity/touches')
      .set(helena.headers)
      .send({ tokens: [UNKNOWN_TOKEN] })
      .expect(404);
    expect(ErrorResponseSchema.parse(touches.body).code).toBe('NOT_FOUND');
    expect(ErrorResponseSchema.parse(unknown.body).code).toBe('NOT_FOUND');
  });

  it('[PROX-08] [4.8] criador → 403 ACCOUNT_TYPE_NOT_ALLOWED (tokens e resolve); [X.3] e-mail não confirmado → 403', async () => {
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
    const resolveUnverified = await t.http
      .post('/v1/proximity/resolve')
      .set(unverifiedHeaders)
      .send({ tokens: [UNKNOWN_TOKEN] })
      .expect(403);
    expect(ErrorResponseSchema.parse(resolveUnverified.body).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('[PROX-20] [PROX-31] 7º token no minuto → 429 com Retry-After (o limite conta a emissão); por conta (outra pessoa segue normal); no minuto seguinte volta', async () => {
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

  it('[PROX-33] (ADR 0013) resolve aceita qualquer token válido de outra pessoa, lido por QR ou NFC (o mesmo conteúdo); token que não resolve não conta como falha', async () => {
    const helena = await person(t);
    const caio = await person(t, 'caio.r');
    await issueToken(t, helena);
    const caioTokens = await issueTokens(t, caio);
    expect(items((await resolveTokens(t, helena, [caioTokens.token]).expect(200)).body)).toEqual([
      expect.objectContaining({ token: caioTokens.token, handle: 'caio.r' }),
    ]);
    for (let index = 0; index < 21; index++) {
      await resolveTokens(t, helena, [UNKNOWN_TOKEN]).expect(200);
    }
    expect(await t.proximity.lockRemainingMs(helena.user.id)).toBe(0);
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

  it('[PROX-05] [X.2] (regressão do BAIXO 1) o resolve continua no findNearby, com o filtro da política no WHERE: dos cinco donos enviados ao banco (livre, bloqueio em cada sentido, excluída e criadora), só a conta livre volta; as idas são lockRemainingMs, hit, isScreenOpen, findValid e findNearby', async () => {
    const helena = await person(t);
    const free = await person(t, 'livre');
    const blockedByHelena = await person(t);
    const blockedHelena = await person(t);
    const deleted = await person(t);
    const creator = await createUser(t.database.db, {
      accountType: 'creator',
      emailVerifiedAt: new Date(),
    });
    await block(t.database.db, helena.user, blockedByHelena.user);
    await block(t.database.db, blockedHelena.user, helena.user);
    await issueToken(t, helena);
    const tokens = [
      await issueToken(t, free),
      await issueToken(t, blockedByHelena),
      await issueToken(t, blockedHelena),
      await issueToken(t, deleted),
    ];
    // A rota não emite token para criador (PROX-08): o token dele vai direto no fake.
    const creatorToken = generateProximityToken();
    await t.proximity.issue(
      hashProximityToken(creatorToken),
      { userId: creator.id, issuedAt: t.clock.now().getTime() },
      { validMs: 30 * SECOND, recentMs: 120 * SECOND, screenMs: 30 * SECOND },
    );
    await t.database.db
      .update(users)
      .set({ deletedAt: t.clock.now() })
      .where(eq(users.id, deleted.user.id));

    const repository = t.app.get(ProximityRepository);
    const nearby = vi.spyOn(repository, 'findNearby');
    try {
      t.proximity.calls.length = 0;
      const response = await resolveTokens(t, helena, [...tokens, creatorToken]).expect(200);
      expect(items(response.body)).toEqual([
        expect.objectContaining({ token: tokens[0], handle: 'livre' }),
      ]);
      expect(t.proximity.calls).toEqual([
        'lockRemainingMs',
        'hit',
        'isScreenOpen',
        'findValid',
        'findNearby',
      ]);
      expect(nearby).toHaveBeenCalledTimes(1);
      // Os cinco donos vão ao banco; o filtro (pessoal, ativa, sem bloqueio) é do WHERE.
      const [viewerId, ids] = nearby.mock.calls[0]!;
      expect(viewerId).toBe(helena.user.id);
      expect([...ids].sort()).toEqual(
        [free, blockedByHelena, blockedHelena, deleted]
          .map((who) => who.user.id)
          .concat(creator.id)
          .sort(),
      );
      const rows = (await nearby.mock.results[0]!.value) as { id: string }[];
      expect(rows.map((row) => row.id)).toEqual([free.user.id]);
    } finally {
      nearby.mockRestore();
    }
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
   * 5 min de tela aberta com `people` pessoas mostrando o QR, cada uma renovando o token a cada
   * 20 s em momentos diferentes (aparelhos não sincronizados). `batchEveryS` = 0: cada token novo é
   * resolvido na hora; senão, os tokens novos vão juntos numa chamada a cada `batchEveryS` segundos.
   * O app resolve o código lido (QR ou NFC); estes casos seguem provando a folga do limite de
   * 30/min com até 20 tokens por chamada.
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

  it('[A-17] 3 pessoas por perto, 5 min, cada token novo resolvido na hora: nunca 429', async () => {
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
  it('[PROX-21] Redis fora → 503 PROXIMITY_UNAVAILABLE em token, resolve, pedido (qr e nfc) e aceite; login, feed, perfil e logout seguem', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    const { request, fromToken } = await pendingRequest(t, helena, caio, 'qr');

    t.proximity.down = true;
    const responses = [
      await t.http.post('/v1/proximity/tokens').set(helena.headers),
      await resolveTokens(t, helena, [UNKNOWN_TOKEN]),
      await requestConnection(t, helena, UNKNOWN_TOKEN),
      await requestConnection(t, helena, UNKNOWN_TOKEN, 'nfc'),
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

  it('[PROX-21] Redis fora em cada passo (emissão, leitura do token no pedido e no aceite) → 503; nada gravado; de volta, tudo segue', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const unavailable = {
      code: 'PROXIMITY_UNAVAILABLE',
      message: 'Conectar está indisponível agora. Tente de novo em instantes.',
    };
    t.proximity.failing.add('issue');
    expect(
      (await t.http.post('/v1/proximity/tokens').set(helena.headers).expect(503)).body,
    ).toEqual(unavailable);
    t.proximity.failing.clear();
    await issueToken(t, helena);
    const caioToken = await issueToken(t, caio);
    t.proximity.failing.add('findValid');
    expect((await requestConnection(t, helena, caioToken, 'nfc').expect(503)).body).toEqual(
      unavailable,
    );
    t.proximity.failing.clear();
    const { request, fromToken } = await pendingRequest(t, helena, caio, 'nfc');
    t.proximity.failing.add('findRecent');
    expect(
      (
        await t.http
          .post(`/v1/connections/requests/${request.id}/accept`)
          .set(caio.headers)
          .send({ observedToken: fromToken })
          .expect(503)
      ).body,
    ).toEqual(unavailable);
    t.proximity.failing.clear();
    await t.http
      .post(`/v1/connections/requests/${request.id}/accept`)
      .set(caio.headers)
      .send({ observedToken: fromToken })
      .expect(200);
  });

  it('[PROX-27] logout e exclusão de conta: os tokens da conta deixam de resolver na hora', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const marina = await person(t);
    await issueTokens(t, helena);
    const caioTokens = await issueTokens(t, caio);
    const marinaToken = await issueToken(t, marina);
    expect(
      items((await resolveTokens(t, helena, [caioTokens.token, marinaToken])).body),
    ).toHaveLength(2);

    await t.http.post('/v1/auth/logout').set(caio.headers).expect(204);
    const marinaSession = await loginViaApi(t.http, marina.user.email);
    await t.http
      .delete('/v1/me')
      .set(bearer(marinaSession.tokens.accessToken))
      .send({ password: TEST_PASSWORD })
      .expect(204);

    expect(
      items((await resolveTokens(t, helena, [caioTokens.token, marinaToken]).expect(200)).body),
    ).toEqual([]);
    expect(t.proximity.entries().filter((entry) => entry.key.endsWith(caio.user.id))).toEqual([]);
  });
});
