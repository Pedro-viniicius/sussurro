// E2E dos tokens de proximidade, do encostar (`touches`) e do resolve do QR (histórias 4.2 e 4.4
// no servidor; ADR 0003 e ADR 0012; testes.md PROX-01, 02, 04, 05, 08, 20, 21, 25, 27, PROX-31 a
// PROX-38, PROX-43 e A-17). As validades de 30 e 120 s, a janela do encosto (5 s, contada do
// primeiro relato; Adendo A2), o ocupado (10 s) e o par (60 s) correm no relógio de teste e no fake
// em memória do Redis (sem `sleep`). Os casos próprios do A2 (teto, revelação garantida, rótulo,
// ocupado, sinal de abuso) ficam em `proximity-touch.e2e-spec.ts`.
import { connectionRequests, eq, users } from '@sussurro/db';
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
import { proximityKeys } from '../../src/modules/proximity/proximity.store.js';
import { bearer, directSession, loginViaApi } from '../support/auth.js';
import {
  issueToken,
  issueTokens,
  type Person,
  person,
  pendingRequest,
  reportTouch,
  requestConnection,
  resolveTokens,
  touchItems,
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

function items(body: unknown) {
  return ProximityResolveResultSchema.parse(body).items;
}

/**
 * As chaves do encosto vivas no fake do Redis: observação (`prox:o`), par (`prox:m`) e, desde o A2,
 * cartão devido (`prox:v`) e ocupado (`prox:c`).
 */
function touchEntries() {
  return t.proximity.entries().filter((entry) => /^prox:[omvc]:/.test(entry.key));
}

/** Observações gravadas com `who` como observador (`prox:o:{who}:*`). */
function observationsBy(who: Person) {
  return t.proximity.entries().filter((entry) => entry.key.startsWith(`prox:o:${who.user.id}:`));
}

function hasPair(first: Person, second: Person): Promise<boolean> {
  return t.proximity.hasTouchPair(first.user.id, second.user.id);
}

describe('POST /proximity/tokens (4.2)', () => {
  it('[PROX-01] [PROX-31] dois tokens distintos (bleToken e qrToken), 16 caracteres base64url (12 bytes), válidos por 30 s, renovar em 20 s; o Redis guarda só os hashes, com o canal', async () => {
    const helena = await person(t);
    const response = await t.http.post('/v1/proximity/tokens').set(helena.headers).expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body as object).sort()).toEqual([
      'bleToken',
      'expiresAt',
      'qrToken',
      'renewInS',
    ]);
    const body = ProximityTokenSchema.parse(response.body);
    for (const token of [body.bleToken, body.qrToken]) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(12);
    }
    expect(body.bleToken).not.toBe(body.qrToken);
    expect(body.expiresAt).toBe(new Date(t.clock.now().getTime() + 30 * SECOND).toISOString());
    expect(body.renewInS).toBe(20);

    const entries = t.proximity.entries();
    expect(entries.map((entry) => entry.key.split(':').slice(0, 2).join(':')).sort()).toEqual([
      'prox:r',
      'prox:r',
      'prox:t',
      'prox:t',
      'prox:u',
      'prox:ut',
    ]);
    for (const entry of entries) {
      for (const token of [body.bleToken, body.qrToken]) {
        expect(entry.key).not.toContain(token);
        expect(entry.value).not.toContain(token);
      }
    }
    // Cada registro guarda dono, emissão e canal; um de cada canal, com a mesma emissão.
    const records = entries
      .filter((entry) => entry.key.startsWith('prox:t:'))
      .map((entry) => JSON.parse(entry.value) as { uid: string; iat: number; ch: string });
    expect(records.map((record) => record.ch).sort()).toEqual(['ble', 'qr']);
    for (const record of records) {
      expect(record).toEqual({ uid: helena.user.id, iat: t.clock.now().getTime(), ch: record.ch });
    }
  });

  it('[PROX-08] [4.8] criador → 403 ACCOUNT_TYPE_NOT_ALLOWED (tokens, resolve e touches); [X.3] e-mail não confirmado → 403', async () => {
    const creator = await createUser(t.database.db, {
      accountType: 'creator',
      emailVerifiedAt: new Date(),
    });
    const creatorHeaders = await directSession(t.app, creator);
    const denied = await t.http.post('/v1/proximity/tokens').set(creatorHeaders).expect(403);
    expect(ErrorResponseSchema.parse(denied.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
    for (const path of ['/v1/proximity/resolve', '/v1/proximity/touches']) {
      const response = await t.http
        .post(path)
        .set(creatorHeaders)
        .send({ tokens: [UNKNOWN_TOKEN] })
        .expect(403);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
    }

    const unverified = await createUser(t.database.db);
    const unverifiedHeaders = await directSession(t.app, unverified);
    const blocked = await t.http.post('/v1/proximity/tokens').set(unverifiedHeaders).expect(403);
    expect(ErrorResponseSchema.parse(blocked.body).code).toBe('EMAIL_NOT_VERIFIED');
    const touches = await t.http
      .post('/v1/proximity/touches')
      .set(unverifiedHeaders)
      .send({ tokens: [UNKNOWN_TOKEN] })
      .expect(403);
    expect(ErrorResponseSchema.parse(touches.body).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('[PROX-20] [PROX-31] 7º token no minuto → 429 com Retry-After (o limite conta a emissão, com os dois tokens); por conta (outra pessoa segue normal); no minuto seguinte volta', async () => {
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

  it('[PROX-33] resolve recusa o bleToken (lido do ar): a mesma resposta de token inexistente, sem contar falha; o qrToken do mesmo dono resolve', async () => {
    const helena = await person(t);
    const caio = await person(t, 'caio.r');
    await issueToken(t, helena);
    const caioTokens = await issueTokens(t, caio);

    const unknown = await resolveTokens(t, helena, [UNKNOWN_TOKEN]).expect(200);
    const ble = await resolveTokens(t, helena, [caioTokens.bleToken]).expect(200);
    expect(ble.body).toEqual({ items: [] });
    expect(ble.text).toBe(unknown.text);
    expect(items((await resolveTokens(t, helena, [caioTokens.qrToken]).expect(200)).body)).toEqual([
      expect.objectContaining({ token: caioTokens.qrToken, handle: 'caio.r' }),
    ]);
    // Os dois juntos: só o do QR vira cartão (o bleToken nunca é o `token` devolvido).
    expect(
      items(
        (await resolveTokens(t, helena, [caioTokens.bleToken, caioTokens.qrToken]).expect(200))
          .body,
      ),
    ).toEqual([expect.objectContaining({ token: caioTokens.qrToken, handle: 'caio.r' })]);
    // Insistir com o bleToken não conta como falha (20 falhas bloqueariam a proximidade).
    for (let index = 0; index < 21; index++) {
      await resolveTokens(t, helena, [caioTokens.bleToken]).expect(200);
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

  it('[PROX-05] [PROX-66] [X.2] (regressão do BAIXO 1) o resolve continua no findNearby, com o filtro da política no WHERE: dos cinco donos enviados ao banco (livre, bloqueio em cada sentido, excluída e criadora), só a conta livre volta; as idas são lockRemainingMs, hit, isScreenOpen, findValid e findNearby, sem o findTouchPair do encosto', async () => {
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
    // A rota não emite token para criador (PROX-08): o `qrToken` dele vai direto no fake.
    const creatorToken = generateProximityToken();
    await t.proximity.issue(
      hashProximityToken(creatorToken),
      { userId: creator.id, issuedAt: t.clock.now().getTime(), channel: 'qr' },
      { validMs: 30 * SECOND, recentMs: 120 * SECOND, screenMs: 30 * SECOND },
    );
    await t.database.db
      .update(users)
      .set({ deletedAt: t.clock.now() })
      .where(eq(users.id, deleted.user.id));

    const repository = t.app.get(ProximityRepository);
    const nearby = vi.spyOn(repository, 'findNearby');
    const touchPair = vi.spyOn(repository, 'findTouchPair');
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
      expect(touchPair).not.toHaveBeenCalled();
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
      touchPair.mockRestore();
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
   * (ADR 0012) O app resolve só o QR lido; estes casos seguem provando a folga do limite de 30/min
   * com até 20 tokens por chamada.
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

describe('POST /proximity/touches: o encosto mútuo (ADR 0012 §3)', () => {
  it('[PROX-32] A relata o bleToken de B (sem cartão); B relata o de A na janela (5 s do primeiro relato de A) e recebe o cartão de A; A, no relato seguinte, recebe o de B pelo cartão devido (sem casamento novo); o par vale 60 s desde o casamento', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    const helenaTokens = await issueTokens(t, helena);
    const caioTokens = await issueTokens(t, caio);

    const first = await reportTouch(t, helena, [caioTokens.bleToken]).expect(200);
    expect(first.body).toEqual({ items: [] });
    expect(await hasPair(helena, caio)).toBe(false);

    // 4,999 s depois: ainda dentro da janela de 5 s contada do primeiro relato de Helena.
    t.clock.advance(5 * SECOND - 1);
    expect(touchItems(await reportTouch(t, caio, [helenaTokens.bleToken]).expect(200))).toEqual([
      {
        token: helenaTokens.bleToken,
        handle: 'helena',
        name: helena.user.name,
        avatarUrl: null,
        alreadyConnected: false,
        // (A2 rev. 1, R1-10) Quanto falta para o par vencer, em degraus de 5 s (PROX-64).
        pairExpiresInS: 55,
      },
    ]);
    expect(await hasPair(helena, caio)).toBe(true);
    // (ADR 0012, A3-1) O primeiro relato de Helena também chegou ao script do casamento (`gone`:
    // Caio ainda não tinha relatado); o de Caio casou.
    expect(t.proximity.claims).toEqual(['gone', 'created']);

    // Revelação simétrica (A2-2): Helena recebe o cartão de Caio no relato seguinte (cerca de 1 s).
    // É a entrega do cartão devido, não um casamento novo: o par não é renovado. O prazo é o mesmo
    // dos dois lados (1 s depois do casamento, ainda 55).
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, helena, [caioTokens.bleToken]).expect(200))).toEqual([
      {
        token: caioTokens.bleToken,
        handle: 'caio.r',
        name: caio.user.name,
        avatarUrl: null,
        alreadyConnected: false,
        pairExpiresInS: 55,
      },
    ]);
    // A entrega do cartão devido não chega ao script.
    expect(t.proximity.claims).toEqual(['gone', 'created']);

    // O par (PROX_TOUCH_PAIR_TTL_S = 60 s) conta do casamento (o relato de Caio, 1 s atrás).
    t.clock.advance(59 * SECOND - 1);
    expect(await hasPair(caio, helena)).toBe(true);
    t.clock.advance(1);
    expect(await hasPair(caio, helena)).toBe(false);
  });

  it('[PROX-32] relato de um lado só nunca casa: 8 relatos em 8 s → sempre [] e sem par; relatar o token de quem não relatou não revela quem relatou', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const marina = await person(t);
    const helenaTokens = await issueTokens(t, helena);
    const caioTokens = await issueTokens(t, caio);
    await issueTokens(t, marina);
    for (let index = 0; index < 8; index++) {
      expect(
        (await reportTouch(t, helena, [caioTokens.bleToken]).expect(200)).body,
        `relato ${String(index + 1)}`,
      ).toEqual({ items: [] });
      t.clock.advance(SECOND);
    }
    expect(await hasPair(helena, caio)).toBe(false);
    expect(touchEntries().filter((entry) => entry.key.startsWith('prox:m:'))).toEqual([]);

    // Marina relatou Helena; Helena relata o token de Caio (que não relatou ninguém): nem o cartão
    // de Caio nem o de Marina.
    expect((await reportTouch(t, marina, [helenaTokens.bleToken]).expect(200)).body).toEqual({
      items: [],
    });
    expect((await reportTouch(t, helena, [caioTokens.bleToken]).expect(200)).body).toEqual({
      items: [],
    });
    expect(await hasPair(helena, marina)).toBe(false);
    expect(await hasPair(helena, caio)).toBe(false);
  });

  it('[PROX-32] [PROX-48] recíproco fora da janela (5 s do primeiro relato) não casa, mesmo com a chave viva; casa quando o relato chega a menos de 5 s do primeiro relato do outro', async () => {
    const helena = await person(t);
    const caio = await person(t, 'caio.r');
    const helenaTokens = await issueTokens(t, helena);
    const caioTokens = await issueTokens(t, caio);

    await reportTouch(t, helena, [caioTokens.bleToken]).expect(200);
    // Exatamente 5 s depois: a observação de Helena ainda existe (vive 10 s), mas o primeiro relato
    // dela já passou da janela.
    t.clock.advance(5 * SECOND);
    expect(observationsBy(helena)).toHaveLength(1);
    expect((await reportTouch(t, caio, [helenaTokens.bleToken]).expect(200)).body).toEqual({
      items: [],
    });
    expect(await hasPair(helena, caio)).toBe(false);
    // Os dois relatos chegaram ao script (A3-1) e voltaram `gone`: o de Helena, sem o relato de
    // Caio; o de Caio, com o primeiro relato de Helena a 5 s.
    expect(t.proximity.claims).toEqual(['gone', 'gone']);

    // Helena relata de novo 1 s depois do relato de Caio: agora sim, mútuo (a observação de Caio
    // abriu a janela dele aos 5 s).
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, helena, [caioTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ handle: 'caio.r', token: caioTokens.bleToken }),
    ]);
    expect(await hasPair(helena, caio)).toBe(true);
  });

  it('[PROX-32] token vencido (> 30 s), inexistente, alterado, do QR ou do próprio chamador: ignorado em silêncio, sem observação gravada, com a resposta de qualquer não mútuo', async () => {
    const helena = await person(t);
    const caio = await person(t, 'caio.r');
    const helenaTokens = await issueTokens(t, helena);
    const caioTokens = await issueTokens(t, caio);
    // Caio já relatou Helena: se algum desses tokens valesse, Helena receberia o cartão dele.
    await reportTouch(t, caio, [helenaTokens.bleToken]).expect(200);

    const unknown = await reportTouch(t, helena, [UNKNOWN_TOKEN]).expect(200);
    expect(unknown.body).toEqual({ items: [] });
    const altered = `${caioTokens.bleToken.slice(0, 15)}${caioTokens.bleToken.endsWith('A') ? 'B' : 'A'}`;
    // (A2-1) Um token por chamada: a mistura de vários numa chamada agora é 400 (PROX-38).
    for (const tokens of [
      [caioTokens.qrToken],
      [helenaTokens.bleToken],
      [helenaTokens.qrToken],
      [altered],
    ]) {
      const response = await reportTouch(t, helena, tokens).expect(200);
      expect(response.text, tokens.join(',')).toBe(unknown.text);
    }
    expect(observationsBy(helena)).toEqual([]);
    expect(await hasPair(helena, caio)).toBe(false);

    // Vencido: o bleToken antigo de Caio passou dos 30 s; Caio relata Helena de novo (na janela).
    t.clock.advance(31 * SECOND);
    const helenaNow = await issueTokens(t, helena);
    const caioNow = await issueTokens(t, caio);
    await reportTouch(t, caio, [helenaNow.bleToken]).expect(200);
    const expired = await reportTouch(t, helena, [caioTokens.bleToken]).expect(200);
    expect(expired.text).toBe(unknown.text);
    expect(observationsBy(helena)).toEqual([]);
    // Controle: com o token novo de Caio, casa.
    expect(touchItems(await reportTouch(t, helena, [caioNow.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ handle: 'caio.r', token: caioNow.bleToken }),
    ]);
  });

  it('[PROX-38] exatamente 1 token por chamada (A2-1); 0, 2 (mesmo repetidos), sem `tokens`, mal formado ou campo a mais (rssi, txPower, model) → 400 sem gravar nada', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const caioTokens = await issueTokens(t, caio);
    await issueTokens(t, helena);
    const bodies: unknown[] = [
      { tokens: [] },
      { tokens: [caioTokens.bleToken, UNKNOWN_TOKEN] },
      { tokens: [caioTokens.bleToken, caioTokens.bleToken] },
      { tokens: Array.from({ length: 4 }, (_, index) => `AAAAAAAAAAAAAAA${String(index)}`) },
      {},
      { tokens: ['curto'] },
      { tokens: 'AAAAAAAAAAAAAAAA' },
      { tokens: [caioTokens.bleToken], rssi: -40 },
      { tokens: [caioTokens.bleToken], txPower: -21 },
      { tokens: [caioTokens.bleToken], model: 'SM-S918B' },
      { tokens: [{ token: caioTokens.bleToken, rssi: -40 }] },
    ];
    for (const body of bodies) {
      const response = await t.http
        .post('/v1/proximity/touches')
        .set(helena.headers)
        .send(body as object);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
    }
    expect(observationsBy(helena)).toEqual([]);

    // 1 token: 200, uma observação.
    await reportTouch(t, helena, [caioTokens.bleToken]).expect(200);
    expect(observationsBy(helena).map((entry) => entry.key)).toEqual([
      proximityKeys.touch(helena.user.id, caio.user.id),
    ]);
  });

  it('[PROX-34] sem cartão devido (com ele, PROX-60): 61º relato no minuto → 429 com Retry-After; por conta; relato que não casa nunca conta como falha (60 sem par não bloqueiam a proximidade); no minuto seguinte volta', async () => {
    const helena = await person(t);
    const caio = await person(t);
    await issueTokens(t, helena);
    await issueTokens(t, caio);
    for (let index = 0; index < 60; index++) {
      await reportTouch(t, helena, [UNKNOWN_TOKEN]).expect(200);
    }
    const limited = await reportTouch(t, helena, [UNKNOWN_TOKEN]).expect(429);
    expect(ErrorResponseSchema.parse(limited.body).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await reportTouch(t, caio, [UNKNOWN_TOKEN]).expect(200);
    // 20 falhas de token em 10 min bloqueariam a proximidade; 61 relatos sem par, não.
    expect(await t.proximity.lockRemainingMs(helena.user.id)).toBe(0);
    await issueTokens(t, helena);

    t.clock.advance(61 * SECOND);
    await issueTokens(t, helena);
    await reportTouch(t, helena, [UNKNOWN_TOKEN]).expect(200);
  });

  it('[PROX-34] relato contínuo a 1 por segundo (o ritmo do app), com os tokens rodando a cada 20 s, por 3 min: nunca 429', async () => {
    const helena = await person(t);
    const caio = await person(t);
    let caioBle = '';
    const statuses: number[] = [];
    for (let second = 0; second < 3 * 60; second++) {
      if (second % 20 === 0) {
        await issueTokens(t, helena);
        caioBle = (await issueTokens(t, caio)).bleToken;
      }
      statuses.push((await reportTouch(t, helena, [caioBle])).status);
      t.clock.advance(SECOND);
    }
    expect(statuses).toHaveLength(180);
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it('[PROX-34] [PROX-04] sem cartão devido (com ele, PROX-60): sem a tela aberta → 409 PROXIMITY_SCREEN_CLOSED, sem gravar; com a proximidade bloqueada (20 falhas) → 429', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const caioTokens = await issueTokens(t, caio);
    const closed = await reportTouch(t, helena, [caioTokens.bleToken]).expect(409);
    expect(ErrorResponseSchema.parse(closed.body).code).toBe('PROXIMITY_SCREEN_CLOSED');
    expect(observationsBy(helena)).toEqual([]);

    await issueTokens(t, helena);
    await t.proximity.lock(helena.user.id, 15 * MINUTE);
    const locked = await reportTouch(t, helena, [caioTokens.bleToken]).expect(429);
    expect(ErrorResponseSchema.parse(locked.body).code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(13 * 60);
    expect(observationsBy(helena)).toEqual([]);
  });

  it('[PROX-36] [X.2] bloqueio em qualquer sentido e conta excluída: nenhum dos dois lados recebe o cartão nem o par; a resposta é a de token inexistente', async () => {
    const helena = await person(t);
    const blockedByHelena = await person(t);
    const blockedHelena = await person(t);
    const deleted = await person(t);
    await block(t.database.db, helena.user, blockedByHelena.user);
    await block(t.database.db, blockedHelena.user, helena.user);
    const helenaTokens = await issueTokens(t, helena);
    const others = [blockedByHelena, blockedHelena, deleted];
    const tokensOf = new Map<Person, string>();
    for (const other of others) {
      tokensOf.set(other, (await issueTokens(t, other)).bleToken);
      await reportTouch(t, other, [helenaTokens.bleToken]).expect(200);
    }
    // Excluída direto no banco: os tokens continuam no Redis, então quem barra é a política.
    await t.database.db
      .update(users)
      .set({ deletedAt: t.clock.now() })
      .where(eq(users.id, deleted.user.id));

    const unknown = await reportTouch(t, helena, [UNKNOWN_TOKEN]).expect(200);
    for (const other of others) {
      const response = await reportTouch(t, helena, [tokensOf.get(other)!]).expect(200);
      expect(response.text).toBe(unknown.text);
      expect(await hasPair(helena, other)).toBe(false);
    }
    // E do outro lado (as duas observações já existem): nada também.
    for (const other of [blockedByHelena, blockedHelena]) {
      const response = await reportTouch(t, other, [helenaTokens.bleToken]).expect(200);
      expect(response.body).toEqual({ items: [] });
    }
    expect(touchEntries().filter((entry) => entry.key.startsWith('prox:m:'))).toEqual([]);
  });

  it('[PROX-37] [PROX-64] o cartão traz só token (o bleToken relatado), @, nome, foto, alreadyConnected e pairExpiresInS (A2 rev. 1, R1-10); nada de id, e-mail, horário ou de quem relatou primeiro (o cartão na hora e o devido trazem o mesmo pairExpiresInS); no-store; o primeiro relato é idêntico ao de token inexistente', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    await connect(t.database.db, helena.user, caio.user);
    const helenaTokens = await issueTokens(t, helena);
    const caioTokens = await issueTokens(t, caio);

    const unknown = await reportTouch(t, helena, [UNKNOWN_TOKEN]).expect(200);
    const first = await reportTouch(t, helena, [caioTokens.bleToken]).expect(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.text).toBe(unknown.text);

    t.clock.advance(SECOND);
    const second = await reportTouch(t, caio, [helenaTokens.bleToken]).expect(200);
    expect(second.headers['cache-control']).toBe('no-store');
    expect(Object.keys(second.body as object)).toEqual(['items']);
    const [card] = (second.body as { items: Record<string, unknown>[] }).items;
    const cardKeys = ['alreadyConnected', 'avatarUrl', 'handle', 'name', 'pairExpiresInS', 'token'];
    expect(Object.keys(card!).sort()).toEqual(cardKeys);
    expect(card).toEqual({
      token: helenaTokens.bleToken,
      handle: 'helena',
      name: helena.user.name,
      avatarUrl: null,
      alreadyConnected: true,
      pairExpiresInS: 55,
    });
    for (const secret of [
      helena.user.id,
      helena.user.email,
      helenaTokens.qrToken,
      caio.user.id,
      String(t.clock.now().getTime()),
    ]) {
      expect(second.text).not.toContain(secret);
    }

    // O cartão devido de Helena (1 s depois do casamento): as mesmas chaves e o mesmo prazo, então
    // nenhum dos dois sabe quem casou primeiro.
    t.clock.advance(SECOND);
    const delivered = await reportTouch(t, helena, [caioTokens.bleToken]).expect(200);
    expect(delivered.headers['cache-control']).toBe('no-store');
    const [owed] = (delivered.body as { items: Record<string, unknown>[] }).items;
    expect(Object.keys(owed!).sort()).toEqual(cardKeys);
    expect(owed).toEqual({
      token: caioTokens.bleToken,
      handle: 'caio.r',
      name: caio.user.name,
      avatarUrl: null,
      alreadyConnected: true,
      pairExpiresInS: card!.pairExpiresInS,
    });
    for (const secret of [caio.user.id, caio.user.email, caioTokens.qrToken, helena.user.id]) {
      expect(delivered.text).not.toContain(secret);
    }
  });

  it('[PROX-43] [PROX-63] o encosto só guarda ids, horários, hashes e o cartão devido: prox:o = "{primeiroMs}:{hash}", prox:m = horário ou "{horário}:{a|b|ab|ba}" depois de um bloqueio (o mesmo prazo), prox:v = "{hash}|{id, horário, @, nome, chave da foto, alreadyConnected}", prox:c = "1"; nenhum token em claro', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    const helenaTokens = await issueTokens(t, helena);
    const caioTokens = await issueTokens(t, caio);
    const byKey = (entries: { key: string; value: string }[]) =>
      [...entries].sort((first, second) => first.key.localeCompare(second.key));
    const opened = t.clock.now().getTime();
    await reportTouch(t, helena, [caioTokens.bleToken]).expect(200);
    t.clock.advance(SECOND);
    await reportTouch(t, caio, [helenaTokens.bleToken]).expect(200);
    const matched = t.clock.now().getTime();
    const observations = [
      {
        key: proximityKeys.touch(helena.user.id, caio.user.id),
        value: `${String(opened)}:${hashProximityToken(caioTokens.bleToken)}`,
      },
      {
        key: proximityKeys.touch(caio.user.id, helena.user.id),
        value: `${String(matched)}:${hashProximityToken(helenaTokens.bleToken)}`,
      },
      { key: proximityKeys.pair(helena.user.id, caio.user.id), value: String(matched) },
      { key: proximityKeys.busy(caio.user.id), value: '1' },
    ];
    // Caio casou: o cartão dele fica devido a Helena, com o hash do token dele que ela relatou.
    const owedValue = `${hashProximityToken(caioTokens.bleToken)}|${JSON.stringify({
      s: caio.user.id,
      at: matched,
      h: 'caio.r',
      n: caio.user.name,
      a: null,
      c: false,
    })}`;
    expect(byKey(touchEntries())).toEqual(
      byKey([...observations, { key: proximityKeys.owed(helena.user.id), value: owedValue }]),
    );

    // Helena recebe o cartão: (ADR 0012, A3-2) o devido não some, fica marcado como entregue
    // (`"!{hash}|{json}"`, por até 10 s, para a reentrega), e ela fica ocupada; a observação dela
    // não muda (a entrega não grava relato).
    t.clock.advance(SECOND);
    await reportTouch(t, helena, [caioTokens.bleToken]).expect(200);
    expect(byKey(touchEntries())).toEqual(
      byKey([
        ...observations,
        { key: proximityKeys.owed(helena.user.id), value: `!${owedValue}` },
        { key: proximityKeys.busy(helena.user.id), value: '1' },
      ]),
    );
    // O cartão entregue e o ocupado somem juntos, 10 s depois da 1ª entrega.
    const helenaKeys = [proximityKeys.owed(helena.user.id), proximityKeys.busy(helena.user.id)];
    const liveHelenaKeys = () =>
      touchEntries()
        .map((entry) => entry.key)
        .filter((key) => helenaKeys.includes(key));
    t.clock.advance(10 * SECOND - 1);
    expect(liveHelenaKeys().sort()).toEqual([...helenaKeys].sort());
    t.clock.advance(1);
    expect(liveHelenaKeys()).toEqual([]);

    // (A2 rev. 1, R1-6) Os bloqueios pelo cartão (desconhecidos com o par vivo, R1-5) marcam o
    // sentido no valor do par: `a` = o menor id bloqueou o maior, `b` = o contrário, na ordem da
    // contagem. O par continua vivo e com o mesmo prazo (60 s desde o casamento).
    const helenaFirst = helena.user.id < caio.user.id;
    const [byHelena, byCaio] = helenaFirst ? ['a', 'b'] : ['b', 'a'];
    const pairKey = proximityKeys.pair(helena.user.id, caio.user.id);
    const pairValue = () => touchEntries().find((entry) => entry.key === pairKey)?.value;
    await t.http.post('/v1/me/blocks').set(helena.headers).send({ handle: 'caio.r' }).expect(204);
    expect(pairValue()).toBe(`${String(matched)}:${byHelena}`);
    await t.http.post('/v1/me/blocks').set(caio.headers).send({ handle: 'helena' }).expect(204);
    expect(pairValue()).toBe(`${String(matched)}:${byHelena}${byCaio}`);
    expect(await hasPair(helena, caio)).toBe(true);

    for (const entry of t.proximity.entries()) {
      for (const token of [
        helenaTokens.bleToken,
        helenaTokens.qrToken,
        caioTokens.bleToken,
        caioTokens.qrToken,
      ]) {
        expect(entry.key).not.toContain(token);
        expect(entry.value).not.toContain(token);
      }
    }

    t.clock.advance(matched + 60 * SECOND - 1 - t.clock.now().getTime());
    expect(pairValue()).toBe(`${String(matched)}:${byHelena}${byCaio}`);
    t.clock.advance(1);
    expect(pairValue()).toBeUndefined();
  });
});

describe('Redis fora e fim de sessão', () => {
  it('[PROX-21] Redis fora → 503 PROXIMITY_UNAVAILABLE em token, resolve, touches, pedido e aceite; login, feed, perfil e logout seguem', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    const { request, fromToken } = await pendingRequest(t, helena, caio, 'qr');

    t.proximity.down = true;
    const responses = [
      await t.http.post('/v1/proximity/tokens').set(helena.headers),
      await resolveTokens(t, helena, [UNKNOWN_TOKEN]),
      await reportTouch(t, helena, [UNKNOWN_TOKEN]),
      await requestConnection(t, helena, UNKNOWN_TOKEN),
      await requestConnection(t, helena, UNKNOWN_TOKEN, 'ble'),
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

  it('[PROX-35] [PROX-54] Redis fora em cada passo do encostar → 503 PROXIMITY_UNAVAILABLE: o relato (recordTouch), o casamento (claimTouchPair), a entrega do cartão devido (takeOwedCard) e o pedido ble (hasTouchPair); nada gravado; de volta, tudo segue', async () => {
    const helena = await person(t);
    const caio = await person(t, 'caio.r');
    const helenaTokens = await issueTokens(t, helena);
    const caioTokens = await issueTokens(t, caio);
    const unavailable = {
      code: 'PROXIMITY_UNAVAILABLE',
      message: 'Conectar está indisponível agora. Tente de novo em instantes.',
    };

    t.proximity.failing.add('recordTouch');
    expect((await reportTouch(t, helena, [caioTokens.bleToken]).expect(503)).body).toEqual(
      unavailable,
    );
    t.proximity.failing.clear();
    await reportTouch(t, helena, [caioTokens.bleToken]).expect(200);

    t.proximity.failing.add('claimTouchPair');
    expect((await reportTouch(t, caio, [helenaTokens.bleToken]).expect(503)).body).toEqual(
      unavailable,
    );
    expect(await hasPair(helena, caio)).toBe(false);
    expect(touchEntries().filter((entry) => /^prox:[vc]:/.test(entry.key))).toEqual([]);
    t.proximity.failing.clear();
    expect(touchItems(await reportTouch(t, caio, [helenaTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: helenaTokens.bleToken }),
    ]);

    // A entrega do cartão devido (o primeiro passo do relato de Helena): sem ela, 503, e o cartão
    // continua guardado para o relato seguinte.
    t.proximity.failing.add('takeOwedCard');
    expect((await reportTouch(t, helena, [caioTokens.bleToken]).expect(503)).body).toEqual(
      unavailable,
    );
    expect(touchEntries().map((entry) => entry.key)).toContain(proximityKeys.owed(helena.user.id));
    t.proximity.failing.clear();
    expect(touchItems(await reportTouch(t, helena, [caioTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: caioTokens.bleToken, handle: 'caio.r' }),
    ]);

    t.proximity.failing.add('hasTouchPair');
    expect(
      (await requestConnection(t, helena, caioTokens.bleToken, 'ble').expect(503)).body,
    ).toEqual(unavailable);
    expect(await t.database.db.select().from(connectionRequests)).toEqual([]);
    t.proximity.failing.clear();
    await requestConnection(t, helena, caioTokens.bleToken, 'ble').expect(201);
  });

  it('[PROX-27] logout e exclusão de conta: os tokens da conta deixam de resolver e de valer no encosto na hora', async () => {
    const helena = await person(t);
    const caio = await person(t);
    const marina = await person(t);
    const helenaTokens = await issueTokens(t, helena);
    const caioTokens = await issueTokens(t, caio);
    const marinaToken = await issueToken(t, marina);
    expect(
      items((await resolveTokens(t, helena, [caioTokens.qrToken, marinaToken])).body),
    ).toHaveLength(2);
    // Caio relatou Helena antes de sair.
    await reportTouch(t, caio, [helenaTokens.bleToken]).expect(200);

    await t.http.post('/v1/auth/logout').set(caio.headers).expect(204);
    const marinaSession = await loginViaApi(t.http, marina.user.email);
    await t.http
      .delete('/v1/me')
      .set(bearer(marinaSession.tokens.accessToken))
      .send({ password: TEST_PASSWORD })
      .expect(204);

    expect(
      items((await resolveTokens(t, helena, [caioTokens.qrToken, marinaToken]).expect(200)).body),
    ).toEqual([]);
    expect((await reportTouch(t, helena, [caioTokens.bleToken]).expect(200)).body).toEqual({
      items: [],
    });
    expect(await hasPair(helena, caio)).toBe(false);
    expect(t.proximity.entries().filter((entry) => entry.key.endsWith(caio.user.id))).toEqual([]);
  });
});
