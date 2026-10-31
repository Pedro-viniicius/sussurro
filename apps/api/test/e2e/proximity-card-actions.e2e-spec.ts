// E2E da revisão 1 do Adendo A2 da ADR 0012 (R1-5 e R1-6; decisão do PO, opção (a)): bloquear e
// denunciar pelo @ do cartão do encosto, com o par vivo (`prox:m`, 60 s), e o sinal de abuso contado
// uma vez por casamento e por sentido. testes.md PROX-61, PROX-62 e PROX-63. Tudo pelas rotas de
// verdade (`POST /me/blocks`, `DELETE /me/blocks/:handle`, `POST /reports`, touches e pedido `ble`),
// com a política em SQL e o fake do Redis sobre o relógio de teste. O `TestProximityStore` registra
// o resultado de cada contagem do sinal (`blockSignals`), que a resposta 204 não mostra.
//
// Fora do par, nada muda (A-05 e X.1 CA1, em `blocks` e `reports`). A única diferença: com alvo que
// a pessoa não vê, a regra consulta o par no Valkey sempre, e o Valkey fora ou lento dá 503 igual
// para qualquer @.
import { blocks, connectionRequests, eq, reports, users } from '@sussurro/db';
import { addComment, block, connect, createPost, createUser } from '@sussurro/db/testing';
import { BlocksPageSchema, ErrorResponseSchema } from '@sussurro/shared';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { proximityKeys } from '../../src/modules/proximity/proximity.store.js';
import {
  type Person,
  person,
  parseRequest,
  requestConnection,
  touch,
} from '../support/proximity.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;
const MODERATION = 'moderacao@sussurro.teste';

beforeAll(async () => {
  t = await createTestApp({ env: { MODERATION_EMAIL: MODERATION } });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
});

const SECOND = 1_000;
/** Validade do par encostado (`PROX_TOUCH_PAIR_TTL_S`, 60 s desde o casamento). */
const PAIR_MS = 60 * SECOND;
/** Passado o ocupado (10 s) e com folga para o limite de 6 emissões por minuto. */
const BETWEEN_TOUCHES_MS = 12 * SECOND;
const MISSING_ID = '01a189e0-af57-7000-85fe-2054e618fea6';
const UNAVAILABLE = {
  code: 'PROXIMITY_UNAVAILABLE',
  message: 'Conectar está indisponível agora. Tente de novo em instantes.',
};

function blockVia(who: Person, body: object) {
  return t.http.post('/v1/me/blocks').set(who.headers).send(body);
}

function unblockVia(who: Person, handle: string) {
  return t.http
    .delete(`/v1/me/blocks/${encodeURIComponent(handle)}`)
    .set(who.headers)
    .expect(204);
}

function reportVia(who: Person, target: object, reason = 'harassment') {
  return t.http.post('/v1/reports').set(who.headers).send({ target, reason });
}

function reportAccount(who: Person, handle: string) {
  return reportVia(who, { type: 'account', handle });
}

/** Os bloqueios gravados por `blocker` (os ids de quem foi bloqueado). */
async function blockedBy(blocker: Person): Promise<string[]> {
  return (await t.database.db.select().from(blocks).where(eq(blocks.blockerId, blocker.user.id)))
    .map((row) => row.blockedId)
    .sort();
}

/** O status, o corpo e os cabeçalhos (sem a data) de uma resposta, para comparar byte a byte. */
function shape(response: Response) {
  const { date: _date, ...headers } = response.headers as Record<string, string>;
  return { status: response.status, text: response.text, headers };
}

function hasPair(first: Person, second: Person): Promise<boolean> {
  return t.proximity.hasTouchPair(first.user.id, second.user.id);
}

/** Conta excluída direto no banco (os tokens continuam no Redis; quem barra é a política). */
async function softDelete(who: Person): Promise<void> {
  await t.database.db
    .update(users)
    .set({ deletedAt: t.clock.now() })
    .where(eq(users.id, who.user.id));
}

describe('bloquear pelo cartão do encosto (ADR 0012, A2 rev. 1, R1-5)', () => {
  it('[PROX-61] desconhecidos com par vivo: o bloqueio pelo @ é gravado (204), nos dois sentidos e também quando o outro já bloqueou quem chama; o pedido pendente do par é cancelado; o bloqueado aparece no GET /me/blocks (só @ e data); o pedido ble depois do bloqueio → 400 genérico', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const { bTokens: mTokens } = await touch(t, v, m);
    const pending = parseRequest(
      await requestConnection(t, v, mTokens.bleToken, 'ble').expect(201),
    );

    // M bloqueia V pelo @ (são desconhecidos: M não vê o perfil de V).
    const blocked = await blockVia(m, { handle: 'vera' }).expect(204);
    expect(blocked.text).toBe('');
    expect(await blockedBy(m)).toEqual([v.user.id]);
    const [request] = await t.database.db
      .select()
      .from(connectionRequests)
      .where(eq(connectionRequests.id, pending.id));
    expect(request!.status).toBe('cancelled');
    // Na lista de quem bloqueou: só o @ e a data.
    const list = await t.http.get('/v1/me/blocks').set(m.headers).expect(200);
    const page = BlocksPageSchema.parse(list.body);
    expect(page.items.map((item) => Object.keys(item).sort())).toEqual([['blockedAt', 'handle']]);
    expect(page.items.map((item) => item.handle)).toEqual(['vera']);

    // V bloqueia M também, com M já a bloqueando: grava (a regra do par vale mesmo assim).
    await blockVia(v, { handle: 'mauro' }).expect(204);
    expect(await blockedBy(v)).toEqual([m.user.id]);

    // O pedido ble depois do bloqueio: o 400 genérico, nada gravado.
    const refused = await requestConnection(t, v, mTokens.bleToken, 'ble').expect(400);
    expect(ErrorResponseSchema.parse(refused.body).code).toBe('PROXIMITY_TOKEN_INVALID');
    expect(await t.database.db.select().from(connectionRequests)).toHaveLength(1);
  });

  it('[PROX-61] [A-05] sem par → o mesmo 204 do sucesso, sem gravar: sem encosto, ou 60 s depois do casamento (com 59,999 s ainda grava); conta excluída com par vivo → 204 sem gravar; o próprio @ → 400', async () => {
    // Referência: um bloqueio que grava (par vivo há 59,999 s).
    const a = await person(t, 'ana');
    const b = await person(t, 'bia');
    await touch(t, a, b);
    t.clock.advance(PAIR_MS - 1);
    const success = await blockVia(a, { handle: 'bia' }).expect(204);
    expect(await blockedBy(a)).toEqual([b.user.id]);

    // Sem encosto.
    const v = await person(t, 'vera');
    await person(t, 'mauro');
    // 60 s depois do casamento.
    const c = await person(t, 'caio.c');
    const d = await person(t, 'duda');
    await touch(t, c, d);
    t.clock.advance(PAIR_MS);
    // Conta excluída com o par vivo.
    const e = await person(t, 'edu');
    const f = await person(t, 'fabi');
    await touch(t, e, f);
    await softDelete(f);

    for (const [who, handle] of [
      [v, 'mauro'],
      [c, 'duda'],
      [e, 'fabi'],
    ] as const) {
      const response = await blockVia(who, { handle });
      expect({ handle, ...shape(response) }).toEqual({ handle, ...shape(success) });
      expect(await blockedBy(who), handle).toEqual([]);
    }
    expect(await hasPair(e, f)).toBe(true);
    expect(t.proximity.blockSignals).toEqual([{ blocker: 1, blocked: 1 }]);

    // O próprio @ → 400, com ou sem par.
    const self = await blockVia(e, { handle: 'edu' }).expect(400);
    expect(ErrorResponseSchema.parse(self.body).code).toBe('VALIDATION_ERROR');
    expect(await t.database.db.select().from(blocks)).toHaveLength(1);
  });

  it('[PROX-61] criador visível → bloqueado como hoje (204, gravado, sem consultar o Valkey); criador que a pessoa não vê (há bloqueio entre os dois), mesmo com um par → 204 sem gravar (a regra do par só vale entre contas pessoais)', async () => {
    const v = await person(t, 'vera');
    await createUser(t.database.db, { accountType: 'creator', handle: 'criadora' });
    // Sem o Valkey para o par: o criador é visível, então nem consulta.
    t.proximity.failing.add('hasTouchPair');
    await blockVia(v, { handle: 'criadora' }).expect(204);
    t.proximity.failing.clear();
    expect(await blockedBy(v)).toHaveLength(1);

    // Um criador que bloqueou W não é visível para W; nem um par (gravado direto, um criador não
    // encosta) o torna bloqueável pelo @.
    const w = await person(t, 'wanda');
    const hidden = await createUser(t.database.db, { accountType: 'creator', handle: 'oculta' });
    await block(t.database.db, hidden, w.user);
    await t.proximity.markTouchPair(w.user.id, hidden.id, PAIR_MS, t.clock.now().getTime());
    expect(await t.proximity.hasTouchPair(w.user.id, hidden.id)).toBe(true);
    await blockVia(w, { handle: 'oculta' }).expect(204);
    expect(await blockedBy(w)).toEqual([]);
  });

  it('[PROX-61] Valkey fora ou lento com alvo não visível → 503 PROXIMITY_UNAVAILABLE com o mesmo corpo para @ com e sem par, inexistente, excluído e inválido, nada gravado; alvo visível (conexão) com o Valkey inteiro fora → 204 gravado, sem consultar o Valkey', async () => {
    const v = await person(t, 'vera');
    const paired = await person(t, 'par');
    const friend = await person(t, 'amiga');
    await connect(t.database.db, v.user, friend.user);
    await createUser(t.database.db, { handle: 'desconhecida' });
    await createUser(t.database.db, { handle: 'excluida', deletedAt: new Date() });
    await touch(t, v, paired);

    t.proximity.failing.add('hasTouchPair');
    const handles = ['par', 'desconhecida', 'naoexiste', 'excluida', 'Inválido!'];
    const responses = [];
    for (const handle of handles) {
      responses.push(await blockVia(v, { handle }));
    }
    for (const [index, response] of responses.entries()) {
      expect({
        handle: handles[index],
        status: response.status,
        body: response.body as unknown,
      }).toEqual({ handle: handles[index], status: 503, body: UNAVAILABLE });
      expect(shape(response)).toEqual(shape(responses[0]!));
    }
    t.proximity.failing.clear();

    // Lento (sem resposta em 500 ms): o mesmo 503. Um caso só, porque cada um custa meio segundo.
    t.proximity.stalling.add('hasTouchPair');
    const slow = await blockVia(v, { handle: 'naoexiste' });
    expect(shape(slow)).toEqual(shape(responses[0]!));
    t.proximity.stalling.clear();
    expect(await t.database.db.select().from(blocks)).toEqual([]);

    // Alvo visível: decide sem o Valkey (e o sinal, em falha aberta, só não conta).
    t.proximity.down = true;
    await blockVia(v, { handle: 'amiga' }).expect(204);
    t.proximity.down = false;
    expect(await blockedBy(v)).toEqual([friend.user.id]);
  });
});

describe('denunciar pelo cartão do encosto (ADR 0012, A2 rev. 1, R1-5)', () => {
  it('[PROX-62] com o par vivo: denunciar a conta pelo @ → 202, denúncia gravada (target_user_id = M) e e-mail para a moderação, também quando M bloqueou V; o par não é consumido; post e comentário de M seguem a regra de sempre (404)', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const post = await createPost(t.database.db, m.user, { text: 'post de M' });
    const comment = await addComment(t.database.db, post, m.user);
    await touch(t, v, m);
    await blockVia(m, { handle: 'vera' }).expect(204);

    const response = await reportAccount(v, 'mauro').expect(202);
    expect(response.text).toBe('');
    const rows = await t.database.db.select().from(reports);
    expect(rows.map((row) => [row.reporterId, row.targetType, row.targetUserId])).toEqual([
      [v.user.id, 'account', m.user.id],
    ]);
    const emails = t.outbox.sent.filter((message) => message.subject.startsWith('Denúncia'));
    expect(emails.map((message) => message.to)).toEqual([MODERATION]);
    expect(emails[0]!.text).toContain('@mauro');
    expect(emails[0]!.text).not.toContain('vera');
    expect(await hasPair(v, m)).toBe(true);

    // Post e comentário: V não vê o conteúdo de M (a regra de sempre); o par não muda isso.
    for (const [target, missing] of [
      [
        { type: 'post', id: post.id },
        { type: 'post', id: MISSING_ID },
      ],
      [
        { type: 'comment', id: comment.id },
        { type: 'comment', id: MISSING_ID },
      ],
    ] as const) {
      const hidden = await reportVia(v, target);
      const absent = await reportVia(v, missing);
      expect({ target, status: hidden.status, body: hidden.body as unknown }).toEqual({
        target,
        status: 404,
        body: absent.body as unknown,
      });
    }
    expect(await t.database.db.select().from(reports)).toHaveLength(1);
  });

  it('[PROX-62] [X.1 CA1] sem par (sem encosto, ou 60 s depois; com 59,999 s ainda vale) ou conta excluída com par → o 404 idêntico ao de @ inexistente; nada gravado nem enviado', async () => {
    const a = await person(t, 'ana');
    const b = await person(t, 'bia');
    await touch(t, a, b);
    t.clock.advance(PAIR_MS - 1);
    await reportAccount(a, 'bia').expect(202);
    const sentBefore = t.outbox.sent.length;

    const v = await person(t, 'vera');
    await person(t, 'mauro');
    const c = await person(t, 'caio.c');
    const d = await person(t, 'duda');
    await touch(t, c, d);
    t.clock.advance(PAIR_MS);
    const e = await person(t, 'edu');
    const f = await person(t, 'fabi');
    await touch(t, e, f);
    await softDelete(f);

    for (const [who, handle] of [
      [v, 'mauro'],
      [c, 'duda'],
      [e, 'fabi'],
    ] as const) {
      const response = await reportAccount(who, handle);
      const missing = await reportAccount(who, 'naoexiste');
      expect({ handle, status: response.status, body: response.body as unknown }).toEqual({
        handle,
        status: 404,
        body: missing.body as unknown,
      });
    }
    expect(await t.database.db.select().from(reports)).toHaveLength(1);
    expect(t.outbox.sent).toHaveLength(sentBefore);
  });

  it('[PROX-62] Valkey fora ou lento com alvo não visível → o mesmo 503 do PROX-61 (para @ com e sem par, inexistente, excluído e inválido), nada gravado nem enviado; alvo visível (conexão) com o Valkey fora → 202', async () => {
    const v = await person(t, 'vera');
    const paired = await person(t, 'par');
    const friend = await person(t, 'amiga');
    await connect(t.database.db, v.user, friend.user);
    await createUser(t.database.db, { handle: 'desconhecida' });
    await createUser(t.database.db, { handle: 'excluida', deletedAt: new Date() });
    await touch(t, v, paired);

    t.proximity.failing.add('hasTouchPair');
    const blockUnavailable = shape(await blockVia(v, { handle: 'par' }));
    for (const handle of ['par', 'desconhecida', 'naoexiste', 'excluida', 'Inválido!']) {
      const response = await reportAccount(v, handle);
      expect({ handle, ...shape(response) }).toEqual({ handle, ...blockUnavailable });
    }
    t.proximity.failing.clear();
    t.proximity.stalling.add('hasTouchPair');
    expect(shape(await reportAccount(v, 'par'))).toEqual(blockUnavailable);
    t.proximity.stalling.clear();
    expect(blockUnavailable.status).toBe(503);
    expect(JSON.parse(blockUnavailable.text)).toEqual(UNAVAILABLE);
    expect(await t.database.db.select().from(reports)).toEqual([]);
    expect(t.outbox.sent).toEqual([]);

    t.proximity.down = true;
    await reportAccount(v, 'amiga').expect(202);
    t.proximity.down = false;
    expect(await t.database.db.select().from(reports)).toHaveLength(1);
  });

  it('[PROX-62] [PROX-61] denunciar e depois bloquear, e bloquear e depois denunciar, dentro dos 60 s e nos dois sentidos → tudo passa; o par continua vivo (não é consumido)', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    await touch(t, v, m);

    await reportAccount(v, 'mauro').expect(202);
    await blockVia(v, { handle: 'mauro' }).expect(204);
    await blockVia(m, { handle: 'vera' }).expect(204);
    await reportAccount(m, 'vera').expect(202);

    expect(await blockedBy(v)).toEqual([m.user.id]);
    expect(await blockedBy(m)).toEqual([v.user.id]);
    const rows = await t.database.db.select().from(reports);
    expect(rows.map((row) => `${row.reporterId}>${row.targetUserId}`).sort()).toEqual(
      [`${v.user.id}>${m.user.id}`, `${m.user.id}>${v.user.id}`].sort(),
    );
    expect(await hasPair(v, m)).toBe(true);
  });
});

describe('o sinal de abuso conta uma vez por casamento e por sentido (ADR 0012, A2 rev. 1, R1-6)', () => {
  it('[PROX-63] com o par vivo: 5 bloqueios simultâneos de V para M → +1 só (blocker:V e blocked:M); bloquear, desbloquear e bloquear de novo (pelo @ e pelo commentId) → nada a mais; M bloqueia V → +1 no sentido dele; prox:m = "{horário}:{sentidos}" com o mesmo prazo, e o par continua vivo; casamento novo (renovação, depois de desbloquear) → conta de novo', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    // Um comentário de M que V vê (no post de um criador): o bloqueio pelo `commentId`.
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const creatorPost = await createPost(t.database.db, creator);
    const comment = await addComment(t.database.db, creatorPost, m.user);
    await touch(t, v, m);
    const marriedAt = t.clock.now().getTime();
    const pairKey = proximityKeys.pair(v.user.id, m.user.id);
    const pairValue = () => t.proximity.entries().find((entry) => entry.key === pairKey)?.value;
    const [byV, byM] = v.user.id < m.user.id ? ['a', 'b'] : ['b', 'a'];

    const parallel = await Promise.all(
      Array.from({ length: 5 }, () => blockVia(v, { handle: 'mauro' })),
    );
    expect(parallel.map((response) => response.status)).toEqual([204, 204, 204, 204, 204]);
    expect(await blockedBy(v)).toEqual([m.user.id]);
    expect(t.proximity.blockSignals.filter((counts) => counts !== null)).toEqual([
      { blocker: 1, blocked: 1 },
    ]);
    expect(pairValue()).toBe(`${String(marriedAt)}:${byV}`);

    // Desbloquear e bloquear de novo, pelo @ e pelo comentário: a marca fica no par.
    await unblockVia(v, 'mauro');
    await blockVia(v, { handle: 'mauro' }).expect(204);
    await unblockVia(v, 'mauro');
    await blockVia(v, { commentId: comment.id }).expect(204);
    expect(await blockedBy(v)).toEqual([m.user.id]);
    expect(t.proximity.blockSignals.filter((counts) => counts !== null)).toHaveLength(1);

    // O outro sentido conta uma vez.
    await blockVia(m, { handle: 'vera' }).expect(204);
    expect(t.proximity.blockSignals.at(-1)).toEqual({ blocker: 1, blocked: 1 });
    await unblockVia(m, 'vera');
    await blockVia(m, { handle: 'vera' }).expect(204);
    expect(t.proximity.blockSignals.at(-1)).toBeNull();
    expect(pairValue()).toBe(`${String(marriedAt)}:${byV}${byM}`);
    expect(await hasPair(v, m)).toBe(true);

    // Casamento novo (a renovação, com o par ainda vivo e depois de desbloquear): conta de novo.
    t.clock.advance(BETWEEN_TOUCHES_MS);
    await unblockVia(v, 'mauro');
    await unblockVia(m, 'vera');
    await touch(t, v, m);
    expect(t.proximity.claims).toEqual(['created', 'renewed']);
    const renewedAt = t.clock.now().getTime();
    expect(pairValue()).toBe(String(renewedAt));
    await blockVia(v, { handle: 'mauro' }).expect(204);
    expect(t.proximity.blockSignals.at(-1)).toEqual({ blocker: 2, blocked: 2 });
    expect(pairValue()).toBe(`${String(renewedAt)}:${byV}`);
    // A marca não mexe no prazo do par (KEEPTTL): 60 s desde a renovação.
    t.clock.advance(renewedAt + PAIR_MS - 1 - t.clock.now().getTime());
    expect(pairValue()).toBe(`${String(renewedAt)}:${byV}`);
    t.clock.advance(1);
    expect(pairValue()).toBeUndefined();
  });

  it('[PROX-63] [PROX-55] uma conta sozinha não leva M a 3 sem 3 casamentos (no mesmo casamento, bloquear e desbloquear 4 vezes soma 1); 3 contas diferentes bloqueando M → um e-mail ("recebeu 3 bloqueios", nunca "3 pessoas", com a orientação de conferir blocks), com o @ de M e sem o das outras', async () => {
    const m = await person(t, 'mauro.m');
    const v = await person(t, 'vera');
    const signals = () =>
      t.outbox.sent.filter((message) => message.subject.startsWith('Sinal no Conectar'));

    await touch(t, v, m);
    for (let round = 0; round < 4; round++) {
      await blockVia(v, { handle: 'mauro.m' }).expect(204);
      await unblockVia(v, 'mauro.m');
    }
    expect(t.proximity.blockSignals.filter((counts) => counts !== null)).toEqual([
      { blocker: 1, blocked: 1 },
    ]);
    expect(signals()).toEqual([]);

    const others: Person[] = [];
    for (const handle of ['outra1', 'outra2']) {
      t.clock.advance(BETWEEN_TOUCHES_MS);
      const other = await person(t, handle);
      others.push(other);
      await touch(t, other, m);
      await blockVia(other, { handle: 'mauro.m' }).expect(204);
    }
    expect(t.proximity.blockSignals.filter((counts) => counts !== null).at(-1)).toEqual({
      blocker: 1,
      blocked: 3,
    });
    const sent = signals();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(MODERATION);
    expect(sent[0]!.subject).toBe(
      'Sinal no Conectar: @mauro.m recebeu 3 bloqueios logo depois de encostar',
    );
    expect(sent[0]!.text).toContain(
      'Sinal: recebeu 3 bloqueios até 60 s depois de um encosto, nos últimos 7 dias.',
    );
    expect(sent[0]!.text).toContain(
      'Cada encosto conta no máximo um bloqueio em cada sentido, mas os 3 podem envolver a mesma pessoa, em encostos diferentes.',
    );
    expect(sent[0]!.text).toContain('com blocked_id igual ao id de @mauro.m');
    expect(`${sent[0]!.subject}\n${sent[0]!.text}`).not.toContain('3 pessoas');
    for (const other of [v, ...others]) {
      expect(`${sent[0]!.subject}\n${sent[0]!.text}`).not.toContain(other.user.handle);
      expect(`${sent[0]!.subject}\n${sent[0]!.text}`).not.toContain(other.user.id);
    }
    expect(`${sent[0]!.subject}\n${sent[0]!.text}`).not.toContain(m.user.id);
  });
});
