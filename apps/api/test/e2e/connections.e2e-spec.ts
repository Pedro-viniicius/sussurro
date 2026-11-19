// E2E dos pedidos de conexão e de desfazer conexão (histórias 4.5, 4.6, 4.9 e 4.10; ADR 0003 e
// ADR 0013; testes.md PROX-03, 06, 07, 09 a 20, 22, 23, 26, 27, PROX-40 e 41, CNT-03, FEED-11,
// PERM-13; X.2 CA2; D7 e D8). O tempo corre no relógio de teste (sem `sleep`) e os tokens ficam no
// fake em memória do Redis. Desde a ADR 0013: um token só por emissão (o mesmo no QR e no NFC); o
// pedido `qr` e o `nfc` têm as mesmas regras, e o aceite exige o token de A nos dois (D7).
import { connectionRequests, connections, eq, users } from '@sussurro/db';
import {
  addComment,
  block,
  connect,
  createPost,
  createUser,
  TEST_PASSWORD,
} from '@sussurro/db/testing';
import {
  ConnectionsPageSchema,
  ErrorResponseSchema,
  FeedPageSchema,
  IncomingConnectionRequestsSchema,
  MeSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PROXIMITY_LIMITS } from '../../src/modules/proximity/proximity-token.js';
import { bearer, directSession, directUser, loginViaApi } from '../support/auth.js';
import {
  acceptRequest,
  issueToken,
  issueTokens,
  parseRequest,
  pendingRequest,
  type Person,
  person,
  renewSession,
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
const MINUTE = 60 * SECOND;
const MISSING_ID = '01a189e0-af57-7000-85fe-2054e618fea6';

/** A resposta genérica do pedido recusado por token (a mesma para recusa, bloqueio e vencido). */
const GENERIC = {
  code: 'PROXIMITY_TOKEN_INVALID',
  message: 'Não foi possível enviar o pedido agora. Tente mais tarde.',
};

function connectionRows() {
  return t.database.db.select().from(connections);
}

/**
 * Falhas de token contadas para a conta na janela de 10 min (PROX-20). O fake só expõe o contador
 * somando: a leitura conta 1 e é descontada. Chame uma vez por conta, no fim do teste.
 */
async function failuresOf(who: Person): Promise<number> {
  const rule = PROXIMITY_LIMITS.failures;
  return (await t.proximity.hit(`rl:${rule.name}:${who.user.id}`, rule.windowMs)).count - 1;
}

function requestRows() {
  return t.database.db.select().from(connectionRequests);
}

function getRequest(who: Person, id: string) {
  return t.http.get(`/v1/connections/requests/${id}`).set(who.headers);
}

async function incoming(who: Person) {
  const response = await t.http
    .get('/v1/connections/requests/incoming')
    .set(who.headers)
    .expect(200);
  return IncomingConnectionRequestsSchema.parse(response.body).items;
}

async function counts(who: Person) {
  const response = await t.http.get('/v1/me').set(who.headers).expect(200);
  const me = MeSchema.parse(response.body);
  return me.accountType === 'personal' ? me.counts.connections : -1;
}

async function myConnections(who: Person) {
  const response = await t.http.get('/v1/me/connections').set(who.headers).expect(200);
  return ConnectionsPageSchema.parse(response.body).items.map((item) => item.handle);
}

describe('pedido A → B (4.5)', () => {
  it('[PROX-06] [PROX-22] com o token válido de B: 201 pending, expira em 120 s, método gravado; B vê na caixa de entrada', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    await issueToken(t, helena);
    const caioToken = await issueToken(t, caio);
    const response = await requestConnection(t, helena, caioToken, 'qr').expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const request = parseRequest(response);
    expect(request).toMatchObject({
      direction: 'outgoing',
      status: 'pending',
      method: 'qr',
      other: { handle: 'caio.r', name: caio.user.name, avatarUrl: null },
      createdAt: t.clock.now().toISOString(),
      expiresAt: new Date(t.clock.now().getTime() + 120 * SECOND).toISOString(),
      expiresInS: 120,
    });
    const [row] = await requestRows();
    expect(row).toMatchObject({
      fromId: helena.user.id,
      toId: caio.user.id,
      status: 'pending',
      method: 'qr',
    });

    t.clock.advance(15 * SECOND);
    const inbox = await incoming(caio);
    expect(inbox).toEqual([
      {
        ...request,
        direction: 'incoming',
        other: { handle: 'helena', name: helena.user.name, avatarUrl: null },
        expiresInS: 105,
      },
    ]);
    expect(await incoming(helena)).toEqual([]);
    expect(parseRequest(await getRequest(helena, request.id).expect(200)).expiresInS).toBe(105);
  });

  it('[PROX-07] o próprio token (inclusive de outro aparelho da mesma conta) → 400 CANNOT_CONNECT_SELF; nada gravado', async () => {
    const helena = await person(t);
    const ownToken = await issueToken(t, helena);
    // "Outro aparelho": outra sessão da mesma conta, que emite o próprio token.
    const otherDevice = { user: helena.user, headers: await directSession(t.app, helena.user) };
    const secondToken = await issueToken(t, otherDevice);
    for (const token of [ownToken, secondToken]) {
      const response = await requestConnection(t, helena, token).expect(400);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('CANNOT_CONNECT_SELF');
    }
    expect(await requestRows()).toEqual([]);
  });

  it('[PROX-07] sem a tela aberta de A → 409 PROXIMITY_SCREEN_CLOSED; token inexistente → mensagem genérica', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const caioToken = await issueToken(t, caio);
    const closed = await requestConnection(t, helena, caioToken).expect(409);
    expect(ErrorResponseSchema.parse(closed.body).code).toBe('PROXIMITY_SCREEN_CLOSED');
    await issueToken(t, helena);
    const unknown = await requestConnection(t, helena, UNKNOWN_TOKEN).expect(400);
    expect(unknown.body).toEqual(GENERIC);
    expect(await requestRows()).toEqual([]);
  });

  it('[PROX-11] (b) tB capturado e reenviado depois de 30 s → recusado; (d) 1 caractere alterado → inexistente', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const caioToken = await issueToken(t, caio);
    t.clock.advance(31 * SECOND);
    await issueToken(t, helena);
    expect((await requestConnection(t, helena, caioToken).expect(400)).body).toEqual(GENERIC);

    const fresh = await issueToken(t, caio);
    const altered = `${fresh.slice(0, 15)}${fresh.endsWith('A') ? 'B' : 'A'}`;
    expect((await requestConnection(t, helena, altered).expect(400)).body).toEqual(GENERIC);
    expect((await resolveTokens(t, helena, [altered]).expect(200)).body).toEqual({ items: [] });
    expect(await requestRows()).toEqual([]);
  });

  it('[PROX-16] A → B de novo com o pendente vivo: 200 com o mesmo pedido; depois de vencer, um pedido novo (201)', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request } = await pendingRequest(t, helena, caio);
    t.clock.advance(10 * SECOND);
    await issueToken(t, helena);
    const again = await requestConnection(t, helena, await issueToken(t, caio)).expect(200);
    expect(parseRequest(again).id).toBe(request.id);

    t.clock.advance(121 * SECOND);
    await issueToken(t, helena);
    const fresh = await requestConnection(t, helena, await issueToken(t, caio)).expect(201);
    expect(parseRequest(fresh).id).not.toBe(request.id);
    const rows = await requestRows();
    expect(rows.map((row) => row.status).sort()).toEqual(['expired', 'pending']);
  });

  it('[PROX-23] B já tem pendente de C; A → B é permitido (o pendente único é por par)', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const marina = await person(t);
    const caioToken = await issueToken(t, caio);
    await issueToken(t, marina);
    await requestConnection(t, marina, caioToken).expect(201);
    await issueToken(t, helena);
    await requestConnection(t, helena, caioToken).expect(201);
    expect((await incoming(caio)).map((item) => item.other.handle)).toEqual([
      marina.user.handle,
      helena.user.handle,
    ]);
  });

  it('[PROX-19] já conectados → 409 ALREADY_CONNECTED', async () => {
    const helena = await person(t);
    const caio = await person(t);
    await connect(t.database.db, helena.user, caio.user);
    await issueToken(t, helena);
    const response = await requestConnection(t, helena, await issueToken(t, caio)).expect(409);
    expect(response.body).toEqual({
      code: 'ALREADY_CONNECTED',
      message: 'Vocês já estão conectados.',
    });
  });

  it('[PROX-22] método fora do enum (inclusive o `ble` antigo, ADR 0013) → 400; sem targetToken → 400', async () => {
    const helena = await person(t);
    await issueToken(t, helena);
    await t.http
      .post('/v1/connections/requests')
      .set(helena.headers)
      .send({ targetToken: UNKNOWN_TOKEN, method: 'ble' })
      .expect(400);
    await t.http
      .post('/v1/connections/requests')
      .set(helena.headers)
      .send({ method: 'nfc' })
      .expect(400);
  });

  it('[X.3] e-mail não confirmado: pedir e aceitar → 403 EMAIL_NOT_VERIFIED; recusar segue liberado', async () => {
    const unverified = await directUser(t.app, t.database.db, { emailVerifiedAt: null });
    const helena = await person(t);
    const denied = await t.http
      .post('/v1/connections/requests')
      .set(unverified.headers)
      .send({ targetToken: UNKNOWN_TOKEN, method: 'nfc' })
      .expect(403);
    expect(ErrorResponseSchema.parse(denied.body).code).toBe('EMAIL_NOT_VERIFIED');

    // A conta não confirmada não emite token: o pedido para ela entra direto no banco.
    const [row] = await t.database.db
      .insert(connectionRequests)
      .values({
        fromId: helena.user.id,
        toId: unverified.user.id,
        method: 'nfc',
        createdAt: t.clock.now(),
        expiresAt: new Date(t.clock.now().getTime() + 120 * SECOND),
      })
      .returning();
    const request = { id: row!.id };
    const fromToken = await issueToken(t, helena);
    await t.http.post('/v1/proximity/tokens').set(unverified.headers).expect(403);
    const accept = await acceptRequest(t, unverified, request.id, fromToken).expect(403);
    expect(ErrorResponseSchema.parse(accept.body).code).toBe('EMAIL_NOT_VERIFIED');
    await t.http
      .post(`/v1/connections/requests/${request.id}/decline`)
      .set(unverified.headers)
      .expect(200);
  });
});

describe('aceite (4.6; ADR 0013 §2: o token de A lido por B, nos dois métodos)', () => {
  it('[PROX-09] [PROX-41] B aceita o pedido nfc com o token de A: conexão com o método do pedido, nas listas, contadores e feed dos dois', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    await createPost(t.database.db, helena.user, {
      text: 'Post da Helena.',
      createdAt: new Date(t.clock.now().getTime() - MINUTE),
    });
    const { request, fromToken } = await pendingRequest(t, helena, caio, 'nfc');
    const response = await acceptRequest(t, caio, request.id, fromToken).expect(200);
    expect(parseRequest(response)).toMatchObject({
      id: request.id,
      direction: 'incoming',
      status: 'accepted',
      method: 'nfc',
      expiresInS: 0,
    });
    const [row] = await connectionRows();
    expect(row).toMatchObject({ method: 'nfc', requestId: request.id });
    expect(parseRequest(await getRequest(helena, request.id).expect(200)).status).toBe('accepted');
    expect(await myConnections(helena)).toEqual(['caio.r']);
    expect(await myConnections(caio)).toEqual(['helena']);
    expect([await counts(helena), await counts(caio)]).toEqual([1, 1]);
    const feed = FeedPageSchema.parse(
      (await t.http.get('/v1/feed?type=text').set(caio.headers).expect(200)).body,
    );
    expect(feed.items.map((item) => item.author.handle)).toEqual(['helena']);
    expect(await incoming(caio)).toEqual([]);
  });

  for (const method of ['qr', 'nfc'] as const) {
    it(`[PROX-09] [PROX-41] ${method}: sem observedToken → 400 VALIDATION_ERROR; com o token de C (válido) ou inexistente → recusado e o pedido continua pendente`, async () => {
      const helena = await person(t);
      const caio = await person(t);
      const marina = await person(t);
      const { request } = await pendingRequest(t, helena, caio, method);
      const missing = await acceptRequest(t, caio, request.id).expect(400);
      expect(ErrorResponseSchema.parse(missing.body).code).toBe('VALIDATION_ERROR');
      const marinaToken = await issueToken(t, marina);
      const refused = await acceptRequest(t, caio, request.id, marinaToken).expect(400);
      expect(refused.body).toEqual(GENERIC);
      const unknown = await acceptRequest(t, caio, request.id, UNKNOWN_TOKEN).expect(400);
      expect(unknown.body).toEqual(GENERIC);
      expect((await requestRows())[0]?.status).toBe('pending');
      expect(await connectionRows()).toEqual([]);
      // O 400 de token ausente não conta como falha; o de C e o inexistente, sim.
      expect(await failuresOf(caio)).toBe(2);
    });
  }

  it('[PROX-03] [PROX-26] qr: tA (o código de A) com 31 a 120 s ainda confirma; com mais de 120 s, não; o tA mais recente (lido há 15 s) confirma aos 110 s do pedido', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const oldToken = await issueToken(t, helena);
    // A tela de A fica aberta (renova a cada 20 s); B observa o tA antigo.
    for (let elapsed = 20; elapsed <= 100; elapsed += 20) {
      t.clock.advance(20 * SECOND);
      await issueToken(t, helena);
    }
    // Aos 100 s, A pede com o token de B.
    const created = await requestConnection(t, helena, await issueToken(t, caio)).expect(201);
    const request = parseRequest(created);
    // Aos 125 s do tA antigo (25 s do pedido): recusado; o pedido segue pendente.
    t.clock.advance(25 * SECOND);
    await issueToken(t, caio);
    expect((await acceptRequest(t, caio, request.id, oldToken).expect(400)).body).toEqual(GENERIC);

    // Aos 110 s do pedido, B envia o tA mais recente, visto há 15 s.
    t.clock.advance(70 * SECOND);
    const recent = await issueToken(t, helena);
    t.clock.advance(15 * SECOND);
    await issueToken(t, caio);
    const accepted = await acceptRequest(t, caio, request.id, recent).expect(200);
    expect(parseRequest(accepted).status).toBe('accepted');
  });

  it('[PROX-03] qr: tA emitido há 60 s (fora dos 30 s, dentro dos 120 s) confirma', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request, fromToken } = await pendingRequest(t, helena, caio, 'qr');
    t.clock.advance(60 * SECOND);
    await issueToken(t, caio);
    await acceptRequest(t, caio, request.id, fromToken).expect(200);
  });

  it('[PROX-10] B sem a tela aberta → 409 PROXIMITY_SCREEN_CLOSED', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request, fromToken } = await pendingRequest(t, helena, caio);
    t.clock.advance(31 * SECOND);
    const closed = await acceptRequest(t, caio, request.id, fromToken).expect(409);
    expect(ErrorResponseSchema.parse(closed.body).code).toBe('PROXIMITY_SCREEN_CLOSED');
    expect(await connectionRows()).toEqual([]);
  });

  it('[PROX-11] (a) qr: observedToken reaproveitado em pedido de outra pessoa → recusado; (c) aceite repetido → mesma resposta e 1 linha', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const marina = await person(t);
    const { request, fromToken } = await pendingRequest(t, helena, caio, 'qr');
    const other = await pendingRequest(t, marina, caio, 'qr');
    expect((await acceptRequest(t, caio, other.request.id, fromToken).expect(400)).body).toEqual(
      GENERIC,
    );

    const first = await acceptRequest(t, caio, request.id, fromToken).expect(200);
    const second = await acceptRequest(t, caio, request.id, fromToken).expect(200);
    expect(second.body).toEqual(first.body);
    expect(await connectionRows()).toHaveLength(1);
  });

  it('[PROX-12] terceiro: aceitar, recusar e ler → 404; B cancelar o pedido de A → 404; A aceitar o próprio pedido → 404', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const marina = await person(t);
    const { request, fromToken } = await pendingRequest(t, helena, caio);
    await issueToken(t, marina);
    const missing = await getRequest(marina, MISSING_ID).expect(404);
    const responses = [
      await acceptRequest(t, marina, request.id, fromToken),
      await t.http.post(`/v1/connections/requests/${request.id}/decline`).set(marina.headers),
      await getRequest(marina, request.id),
      await t.http.delete(`/v1/connections/requests/${request.id}`).set(caio.headers),
      await t.http.delete(`/v1/connections/requests/${request.id}`).set(marina.headers),
      await acceptRequest(t, helena, request.id, fromToken),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(missing.body);
    }
    expect((await requestRows())[0]?.status).toBe('pending');
    await getRequest(helena, 'nao-e-uuid').expect(400);
  });

  it('[PROX-14] dois aceites ao mesmo tempo (dois toques): 1 conexão e respostas iguais', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request, fromToken } = await pendingRequest(t, helena, caio);
    const [first, second] = await Promise.all([
      acceptRequest(t, caio, request.id, fromToken),
      acceptRequest(t, caio, request.id, fromToken),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body).toEqual(second.body);
    expect(await connectionRows()).toHaveLength(1);
  });

  it('[PROX-15] aceite em expires_at + 1 s → 410 REQUEST_EXPIRED; o pedido vira expired; para A, "não confirmado" como a recusa', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request, fromToken } = await pendingRequest(t, helena, caio);
    t.clock.set(new Date(Date.parse(request.expiresAt) + SECOND));
    await issueToken(t, caio);
    const expired = await acceptRequest(t, caio, request.id, fromToken).expect(410);
    expect(expired.body).toEqual({ code: 'REQUEST_EXPIRED', message: 'O pedido expirou.' });
    expect((await requestRows())[0]?.status).toBe('expired');
    expect(parseRequest(await getRequest(caio, request.id).expect(200)).status).toBe('expired');
    const forA = parseRequest(await getRequest(helena, request.id).expect(200));
    expect(forA).toMatchObject({ status: 'not_confirmed', expiresInS: 0 });

    // A recusa aparece para A exatamente igual (não diferenciamos recusa de expiração).
    await t.reset();
    const marina = await person(t);
    const joana = await person(t);
    const declined = await pendingRequest(t, marina, joana);
    await t.http
      .post(`/v1/connections/requests/${declined.request.id}/decline`)
      .set(joana.headers)
      .expect(200);
    const declinedForA = parseRequest(await getRequest(marina, declined.request.id).expect(200));
    expect(declinedForA.status).toBe(forA.status);
    expect(declinedForA.expiresInS).toBe(0);
    expect(await connectionRows()).toEqual([]);
  });

  it('[PROX-19] aceite tardio de pedido já resolvido pela corrida não duplica a conexão', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request, fromToken, fromTokens } = await pendingRequest(t, helena, caio);
    // B também toca em "Conectar" no cartão de A (P5): vira conexão na hora.
    const cross = await requestConnection(t, caio, fromTokens.token, 'nfc').expect(200);
    expect(parseRequest(cross)).toMatchObject({ id: request.id, status: 'accepted' });
    await acceptRequest(t, caio, request.id, fromToken).expect(200);
    expect(await connectionRows()).toHaveLength(1);
  });
});

describe('corrida A → B ∥ B → A (PROX-13)', () => {
  it('[PROX-13] 50 rodadas com os dois pedidos ao mesmo tempo: sempre 1 conexão, 0 pendentes; uma resposta accepted e a outra vira accepted no polling', async () => {
    (t.app.getHttpServer() as { setMaxListeners: (n: number) => void }).setMaxListeners(100);
    for (let round = 0; round < 50; round++) {
      const helena = await person(t);
      const caio = await person(t);
      // Os dois abrem a tela: um lê o código do outro por NFC, o outro pelo QR.
      const helenaTokens = await issueTokens(t, helena);
      const caioTokens = await issueTokens(t, caio);
      const [toCaio, toHelena] = await Promise.all([
        requestConnection(t, helena, caioTokens.token, 'nfc'),
        requestConnection(t, caio, helenaTokens.token, 'qr'),
      ]);
      const pair = (await connectionRows()).filter(
        (row) =>
          [row.userAId, row.userBId].sort().join() === [helena.user.id, caio.user.id].sort().join(),
      );
      expect(pair, `rodada ${String(round)}`).toHaveLength(1);
      const pending = (await requestRows()).filter(
        (row) =>
          row.status === 'pending' &&
          [row.fromId, row.toId].includes(helena.user.id) &&
          [row.fromId, row.toId].includes(caio.user.id),
      );
      expect(pending, `rodada ${String(round)}`).toEqual([]);

      const bodies = [parseRequest(toCaio), parseRequest(toHelena)];
      expect(bodies.map((body) => body.status).sort()).toEqual(['accepted', 'pending']);
      // A conexão fica com o método do pedido aceito (o que chegou primeiro, PROX-22).
      const first = bodies.find((body) => body.status === 'pending')!;
      expect(pair[0]?.method).toBe(first.method);
      expect(pair[0]?.requestId).toBe(first.id);
      // Quem recebeu `pending` vê `accepted` no polling.
      expect(first.direction).toBe('outgoing');
      const poller = parseRequest(toCaio).status === 'pending' ? helena : caio;
      expect(parseRequest(await getRequest(poller, first.id).expect(200)).status).toBe('accepted');
    }
  });
});

describe('pedido e aceite por método (ADR 0013 §2: qr e nfc com as mesmas regras)', () => {
  for (const method of ['qr', 'nfc'] as const) {
    it(`[PROX-40] [PROX-22] pedido ${method}: o token válido de B → 201 ${method}, gravado no pedido; com mais de 30 s ou inexistente → 400 genérico, contado como falha; o próprio → CANNOT_CONNECT_SELF`, async () => {
      const helena = await person(t, 'helena');
      const caio = await person(t, 'caio.r');
      const marina = await person(t, 'marina');
      const helenaToken = await issueToken(t, helena);
      const caioToken = await issueToken(t, caio);
      const created = await requestConnection(t, helena, caioToken, method).expect(201);
      expect(parseRequest(created)).toMatchObject({ method, other: { handle: 'caio.r' } });
      expect((await requestRows())[0]?.method).toBe(method);

      const marinaToken = await issueToken(t, marina);
      t.clock.advance(31 * SECOND);
      await issueToken(t, helena);
      const stale = await requestConnection(t, helena, marinaToken, method).expect(400);
      expect(stale.body).toEqual(GENERIC);
      const unknown = await requestConnection(t, helena, UNKNOWN_TOKEN, method).expect(400);
      expect(unknown.body).toEqual(GENERIC);
      const self = await requestConnection(t, helena, await issueToken(t, helena), method);
      expect(self.status).toBe(400);
      expect(ErrorResponseSchema.parse(self.body).code).toBe('CANNOT_CONNECT_SELF');
      expect(helenaToken).not.toBe(caioToken);
      expect(await requestRows()).toHaveLength(1);
    });

    it(`[PROX-41] aceite ${method}: o token de A lido por B conecta com ${method}; um terceiro aceitando recebe o 404 de inexistente`, async () => {
      const helena = await person(t);
      const caio = await person(t);
      const marina = await person(t);
      const { request, fromToken } = await pendingRequest(t, helena, caio, method);
      await issueToken(t, marina);
      await acceptRequest(t, marina, request.id, fromToken).expect(404);
      const accepted = await acceptRequest(t, caio, request.id, fromToken).expect(200);
      expect(parseRequest(accepted)).toMatchObject({ status: 'accepted', method });
      expect((await connectionRows()).map((row) => row.method)).toEqual([method]);
    });
  }

  it('[PROX-22] pedido antigo `ble` (ADR 0012, histórico no banco): sai como `nfc`, o aceite exige o token de A e a conexão nasce `nfc`', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const fromToken = await issueToken(t, helena);
    await issueToken(t, caio);
    const [row] = await t.database.db
      .insert(connectionRequests)
      .values({
        fromId: helena.user.id,
        toId: caio.user.id,
        method: 'ble',
        createdAt: t.clock.now(),
        expiresAt: new Date(t.clock.now().getTime() + 120 * SECOND),
      })
      .returning();
    const seen = parseRequest(await getRequest(caio, row!.id).expect(200));
    expect(seen.method).toBe('nfc');
    expect((await incoming(caio)).map((item) => item.method)).toEqual(['nfc']);
    await acceptRequest(t, caio, row!.id).expect(400);
    const accepted = await acceptRequest(t, caio, row!.id, fromToken).expect(200);
    expect(parseRequest(accepted).method).toBe('nfc');
    expect((await connectionRows()).map((connection) => connection.method)).toEqual(['nfc']);
  });
});

describe('recusa, cancelamento e limites', () => {
  it('[PROX-17] recusa: novo A → B em menos de 1 h → a mesma mensagem de token inválido; B → A segue livre; depois de 1 h, A → B volta', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request } = await pendingRequest(t, helena, caio);
    const declined = await t.http
      .post(`/v1/connections/requests/${request.id}/decline`)
      .set(caio.headers)
      .expect(200);
    expect(parseRequest(declined).status).toBe('declined');
    expect(parseRequest(await getRequest(helena, request.id).expect(200)).status).toBe(
      'not_confirmed',
    );

    t.clock.advance(59 * MINUTE);
    await renewSession(t, helena, caio);
    await issueToken(t, helena);
    const caioToken = await issueToken(t, caio);
    const again = await requestConnection(t, helena, caioToken).expect(400);
    const invalid = await requestConnection(t, helena, UNKNOWN_TOKEN).expect(400);
    expect(again.text).toBe(invalid.text);
    expect(again.body).toEqual(GENERIC);

    // Quem recusou pode mudar de ideia (A-34).
    const reverse = await requestConnection(t, caio, await issueToken(t, helena)).expect(201);
    await t.http
      .delete(`/v1/connections/requests/${parseRequest(reverse).id}`)
      .set(caio.headers)
      .expect(200);

    t.clock.advance(2 * MINUTE);
    await issueToken(t, helena);
    await requestConnection(t, helena, await issueToken(t, caio)).expect(201);
  });

  it('[PROX-18] A cancela; B não consegue mais aceitar (404); para A, "não confirmado"', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request, fromToken } = await pendingRequest(t, helena, caio);
    const cancelled = await t.http
      .delete(`/v1/connections/requests/${request.id}`)
      .set(helena.headers)
      .expect(200);
    expect(parseRequest(cancelled).status).toBe('not_confirmed');
    expect((await requestRows())[0]?.status).toBe('cancelled');
    await acceptRequest(t, caio, request.id, fromToken).expect(404);
    expect(parseRequest(await getRequest(caio, request.id).expect(200)).status).toBe('cancelled');
    expect(await incoming(caio)).toEqual([]);
    // Cancelar de novo não muda nada.
    await t.http.delete(`/v1/connections/requests/${request.id}`).set(helena.headers).expect(200);
  });

  it('[PROX-20] 11º pedido no minuto e 51º no dia → 429; 11º aceite no minuto → 429', async () => {
    const helena = await person(t);
    const caio = await person(t);
    // 10 por minuto durante 5 minutos = 50 no dia (repetir o pedido vivo também conta).
    for (let minute = 0; minute < 5; minute++) {
      await issueToken(t, helena);
      const caioToken = await issueToken(t, caio);
      for (let index = 0; index < 10; index++) {
        const response = await requestConnection(t, helena, caioToken);
        expect(response.status, `minuto ${String(minute)} pedido ${String(index)}`).toBeLessThan(
          300,
        );
      }
      if (minute === 0) {
        const limited = await requestConnection(t, helena, caioToken).expect(429);
        expect(ErrorResponseSchema.parse(limited.body).code).toBe('RATE_LIMITED');
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      }
      t.clock.advance(MINUTE + SECOND);
    }
    await issueToken(t, helena);
    const daily = await requestConnection(t, helena, await issueToken(t, caio)).expect(429);
    expect(Number(daily.headers['retry-after'])).toBeGreaterThan(3600);

    // Aceites: 10 por minuto (repetidos contam).
    const marina = await person(t);
    const joana = await person(t);
    const { request, fromToken } = await pendingRequest(t, marina, joana);
    for (let index = 0; index < 10; index++) {
      await acceptRequest(t, joana, request.id, fromToken).expect(200);
    }
    await acceptRequest(t, joana, request.id, fromToken).expect(429);
  });

  it('[PROX-20] [4.7 CA7] 20 falhas de token em 10 min bloqueiam a proximidade por 15 min (tokens, resolve, pedido e aceite); outra conta segue livre', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const marina = await person(t);
    const { request, fromToken } = await pendingRequest(t, marina, helena);
    for (let index = 0; index < 20; index++) {
      // 10 pedidos por minuto: a segunda metade fica no minuto seguinte.
      if (index === 10) {
        t.clock.advance(MINUTE + SECOND);
      }
      if (index % 5 === 0) {
        await issueToken(t, helena);
      }
      const failed = await requestConnection(t, helena, UNKNOWN_TOKEN, 'qr');
      expect(failed.body, `falha ${String(index + 1)}`).toEqual(GENERIC);
    }
    const blocked = [
      await t.http.post('/v1/proximity/tokens').set(helena.headers),
      await resolveTokens(t, helena, [UNKNOWN_TOKEN]),
      await requestConnection(t, helena, await issueToken(t, caio), 'qr'),
      await acceptRequest(t, helena, request.id, fromToken),
    ];
    for (const response of blocked) {
      expect(response.status).toBe(429);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('RATE_LIMITED');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(13 * 60);
    }
    await issueToken(t, marina);
    await issueToken(t, caio);

    t.clock.advance(15 * MINUTE);
    await renewSession(t, helena);
    await issueToken(t, helena);
  });

  it('[PROX-22] QR cruzado (D7): A lê o QR de B (qr); B só confirma com o token lido do QR de A; a conexão fica com qr', async () => {
    const helena = await person(t);
    const caio = await person(t);
    await issueToken(t, helena);
    // A lê o QR de B.
    const caioQr = await issueToken(t, caio);
    const request = parseRequest(await requestConnection(t, helena, caioQr, 'qr').expect(201));
    // B tenta aceitar sem ter lido o QR de A (com o próprio token, por exemplo): recusado.
    expect((await acceptRequest(t, caio, request.id, caioQr).expect(400)).body).toEqual(GENERIC);
    // A tela "Aguardando" de A mostra o QR dela (token renovado); B lê e confirma.
    t.clock.advance(20 * SECOND);
    const helenaQr = await issueToken(t, helena);
    await issueToken(t, caio);
    const accepted = await acceptRequest(t, caio, request.id, helenaQr).expect(200);
    expect(parseRequest(accepted)).toMatchObject({ status: 'accepted', method: 'qr' });
    expect((await connectionRows())[0]?.method).toBe('qr');
  });
});

describe('bloqueio, logout e exclusão de conta', () => {
  it('[X.2 CA2] com bloqueio em qualquer sentido, o pedido recebe a mesma mensagem genérica e nada é gravado', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const marina = await person(t);
    await block(t.database.db, caio.user, helena.user);
    await block(t.database.db, helena.user, marina.user);
    await issueToken(t, helena);
    const toBlocker = await requestConnection(t, helena, await issueToken(t, caio)).expect(400);
    const toBlocked = await requestConnection(t, helena, await issueToken(t, marina)).expect(400);
    const unknown = await requestConnection(t, helena, UNKNOWN_TOKEN).expect(400);
    expect(toBlocker.text).toBe(unknown.text);
    expect(toBlocked.text).toBe(unknown.text);
    expect(await requestRows()).toEqual([]);
  });

  it('[X.2 CA3] bloquear cancela o pendente do par: aceite → 404, a caixa de entrada esconde e o pedido some para quem foi bloqueado', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    const { request, fromToken, fromTokens } = await pendingRequest(t, helena, caio);
    // Helena vê o comentário de caio.r num post de criador e bloqueia por ele (D11, sem oráculo).
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, creator, {
      createdAt: new Date(t.clock.now().getTime() - MINUTE),
    });
    const comment = await addComment(t.database.db, post, caio.user);
    await t.http
      .post('/v1/me/blocks')
      .set(helena.headers)
      .send({ commentId: comment.id })
      .expect(204);
    expect((await requestRows())[0]?.status).toBe('cancelled');
    // O token de Helena ainda vale: quem barra é o bloqueio.
    const afterBlock = await t.http
      .post('/v1/connections/requests')
      .set(caio.headers)
      .send({ targetToken: fromTokens.token, method: 'nfc' })
      .expect(400);
    expect(afterBlock.body).toEqual(GENERIC);
    await acceptRequest(t, caio, request.id, fromToken).expect(404);
    await getRequest(caio, request.id).expect(404);
    expect(await incoming(caio)).toEqual([]);
    expect(await connectionRows()).toEqual([]);
  });

  it('[PROX-27] A sai da conta (logout) durante o pedido: aceite → 404; o token de A não vale mais', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request, fromToken } = await pendingRequest(t, helena, caio);
    await t.http.post('/v1/auth/logout').set(helena.headers).expect(204);
    await issueToken(t, caio);
    await acceptRequest(t, caio, request.id, fromToken).expect(404);
    expect((await requestRows())[0]?.status).toBe('cancelled');
    expect((await resolveTokens(t, caio, [fromToken]).expect(200)).body).toEqual({ items: [] });
  });

  it('[PROX-27] A exclui a conta durante o pedido: aceite e leitura → 404; tokens invalidados', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const { request, fromToken } = await pendingRequest(t, helena, caio);
    const session = await loginViaApi(t.http, helena.user.email);
    await t.http
      .delete('/v1/me')
      .set(bearer(session.tokens.accessToken))
      .send({ password: TEST_PASSWORD })
      .expect(204);
    await issueToken(t, caio);
    await acceptRequest(t, caio, request.id, fromToken).expect(404);
    await getRequest(caio, request.id).expect(404);
    expect(await incoming(caio)).toEqual([]);
    expect((await requestRows())[0]?.status).toBe('cancelled');
  });
});

describe('desfazer conexão (4.9, D8)', () => {
  it('[CNT-03] [4.9 CA1] A desfaz: 204, some das duas listas e os contadores caem na hora; B não é avisado', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    await connect(t.database.db, helena.user, caio.user);
    expect([await counts(helena), await counts(caio)]).toEqual([1, 1]);
    t.outbox.clear();
    await t.http.delete('/v1/connections/caio.r').set(helena.headers).expect(204);
    expect(await connectionRows()).toEqual([]);
    expect([await counts(helena), await counts(caio)]).toEqual([0, 0]);
    expect(await myConnections(helena)).toEqual([]);
    expect(await myConnections(caio)).toEqual([]);
    expect(t.outbox.sent).toEqual([]);
  });

  it('[FEED-11] [PERM-13] [4.9 CA2] desfeita: feed (inclusive com cursor antigo), perfil e post do outro → somem / 404, nos dois sentidos', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    await connect(t.database.db, helena.user, caio.user);
    const posts = [];
    for (let index = 0; index < 3; index++) {
      posts.push(
        await createPost(t.database.db, caio.user, {
          text: `Post ${String(index)}`,
          createdAt: new Date(t.clock.now().getTime() - (index + 1) * MINUTE),
        }),
      );
    }
    const firstPage = FeedPageSchema.parse(
      (await t.http.get('/v1/feed?type=text&limit=1').set(helena.headers).expect(200)).body,
    );
    expect(firstPage.items).toHaveLength(1);
    await t.http.get(`/v1/posts/${posts[0]!.id}`).set(helena.headers).expect(200);

    await t.http.delete('/v1/connections/helena').set(caio.headers).expect(204);
    const next = FeedPageSchema.parse(
      (
        await t.http
          .get(`/v1/feed?type=text&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`)
          .set(helena.headers)
          .expect(200)
      ).body,
    );
    expect(next.items).toEqual([]);
    const fresh = FeedPageSchema.parse(
      (await t.http.get('/v1/feed?type=text').set(helena.headers).expect(200)).body,
    );
    expect(fresh.items).toEqual([]);
    const missingProfile = await t.http
      .get('/v1/users/inexistente')
      .set(helena.headers)
      .expect(404);
    for (const [who, handle] of [
      [helena, 'caio.r'],
      [caio, 'helena'],
    ] as const) {
      const profile = await t.http.get(`/v1/users/${handle}`).set(who.headers).expect(404);
      expect(profile.body).toEqual(missingProfile.body);
    }
    await t.http.get(`/v1/posts/${posts[0]!.id}`).set(helena.headers).expect(404);
  });

  it('[4.9 CA3] @ que não é conexão, inexistente, excluído ou a própria conta → 404 idêntico; repetir → 404', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    const marina = await person(t, 'marinac');
    await connect(t.database.db, helena.user, marina.user);
    await t.database.db
      .update(users)
      .set({ deletedAt: t.clock.now() })
      .where(eq(users.id, marina.user.id));
    const missing = await t.http.delete('/v1/connections/ninguem').set(helena.headers).expect(404);
    expect(missing.body).toEqual({ code: 'NOT_FOUND', message: 'Conexão não encontrada' });
    for (const handle of ['caio.r', 'marinac', 'helena', 'x', '%20']) {
      const response = await t.http.delete(`/v1/connections/${handle}`).set(helena.headers);
      expect({ handle, status: response.status, body: response.body as unknown }).toEqual({
        handle,
        status: 404,
        body: missing.body as unknown,
      });
    }
    expect(caio.user.handle).toBe('caio.r');
  });
});
