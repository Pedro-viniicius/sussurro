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
//
// E a decisão do PO R1-PO-1 (2026-10-30), testes.md PROX-65: quem denuncia pode denunciar a conta
// que bloqueou, sem prazo e sem consultar o Valkey. Só na denúncia de conta e só nesse sentido; o
// bloqueio (`POST /me/blocks`), o post e o comentário seguem como acima.
import { blocks, connectionRequests, eq, reports, users } from '@sussurro/db';
import { addComment, block, connect, createPost, createUser } from '@sussurro/db/testing';
import { BlocksPageSchema, ErrorResponseSchema } from '@sussurro/shared';
import type { Response } from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelationsRepository } from '../../src/modules/policies/relations.repository.js';
import { proximityKeys } from '../../src/modules/proximity/proximity.store.js';
import { directUser } from '../support/auth.js';
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
    // (ADR 0012, A3-1) O primeiro relato de cada encosto também chega ao script e volta `gone`.
    expect(t.proximity.claims).toEqual(['gone', 'created', 'gone', 'renewed']);
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

describe('denunciar a conta de quem você bloqueou (R1-PO-1, aprovada pelo PO em 2026-10-30)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** As denúncias gravadas, como `"{quem denunciou}>{conta denunciada}:{tipo}"`. */
  async function reportRows(): Promise<string[]> {
    return (await t.database.db.select().from(reports))
      .map((row) => `${row.reporterId}>${row.targetUserId}:${row.targetType}`)
      .sort();
  }

  /** Os e-mails de denúncia (o sinal de abuso do Conectar tem outro assunto). */
  function reportEmails() {
    return t.outbox.sent.filter((message) => message.subject.startsWith('Denúncia'));
  }

  /** O @ da conta denunciada em cada e-mail ("Alvo: conta @..."), em ordem alfabética. */
  function reportedHandles(): string[] {
    return reportEmails()
      .map((message) => /^Alvo: conta @(\S+)$/m.exec(message.text)?.[1] ?? message.text)
      .sort();
  }

  /** Conta, daqui em diante, as consultas do par no Valkey (a porta `hasTouchPair`). */
  function watchPairChecks() {
    return vi.spyOn(t.proximity, 'hasTouchPair');
  }

  it('[PROX-65] [X.1] V bloqueou M (pela conexão) e N (pelo par, PROX-61) e, 60 s depois do encosto, denuncia os dois → 202 sem corpo, denúncia gravada (target_user_id = a conta) e e-mail para a moderação sem o @ nem o id de V, sem consultar o Valkey; repetir → o mesmo 202, com uma linha e um e-mail por conta', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const n = await person(t, 'nina');
    await connect(t.database.db, v.user, m.user);
    await blockVia(v, { handle: 'mauro' }).expect(204);
    await touch(t, v, n);
    await blockVia(v, { handle: 'nina' }).expect(204);
    expect(await blockedBy(v)).toEqual([m.user.id, n.user.id].sort());
    // O par com N acabou, e o bloqueio desfez a conexão com M: V não vê nenhum dos dois.
    t.clock.advance(PAIR_MS);
    expect(await hasPair(v, n)).toBe(false);
    for (const handle of ['mauro', 'nina']) {
      await t.http.get(`/v1/users/${handle}`).set(v.headers).expect(404);
    }

    const pairChecks = watchPairChecks();
    for (const handle of ['mauro', 'nina']) {
      const response = await reportAccount(v, handle).expect(202);
      expect(response.text).toBe('');
    }
    expect(pairChecks).not.toHaveBeenCalled();
    expect(await reportRows()).toEqual(
      [`${v.user.id}>${m.user.id}:account`, `${v.user.id}>${n.user.id}:account`].sort(),
    );
    const rows = await t.database.db.select().from(reports);
    expect(rows.map((row) => [row.postId, row.commentId])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(reportEmails().map((message) => message.to)).toEqual([MODERATION, MODERATION]);
    expect(reportedHandles()).toEqual(['mauro', 'nina']);
    for (const message of reportEmails()) {
      expect(`${message.subject}\n${message.text}`).not.toContain('vera');
      expect(`${message.subject}\n${message.text}`).not.toContain(v.user.id);
    }

    // Repetir, com o mesmo motivo e com outro → o mesmo 202, sem linha nova nem outro e-mail.
    for (const reason of ['harassment', 'spam']) {
      const again = await reportVia(v, { type: 'account', handle: 'mauro' }, reason).expect(202);
      expect(again.text).toBe('');
    }
    expect(await t.database.db.select().from(reports)).toHaveLength(2);
    expect(reportEmails()).toHaveLength(2);
    expect(pairChecks).not.toHaveBeenCalled();
  });

  it('[PROX-65] [PROX-62] Valkey fora (failing ou down) ou lento (stalling, 500 ms) → a denúncia da conta que V bloqueou continua 202 e gravada, sem 503; na mesma hora, a de um desconhecido dá o 503 de sempre', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const n = await person(t, 'nina');
    const o = await person(t, 'otto');
    await createUser(t.database.db, { handle: 'desconhecida' });
    for (const other of [m, n]) {
      await connect(t.database.db, v.user, other.user);
      await blockVia(v, { handle: other.user.handle }).expect(204);
    }
    await touch(t, v, o);
    await blockVia(v, { handle: 'otto' }).expect(204);
    t.clock.advance(PAIR_MS);

    t.proximity.failing.add('hasTouchPair');
    await reportAccount(v, 'mauro').expect(202);
    const stranger = await reportAccount(v, 'desconhecida');
    expect({ status: stranger.status, body: stranger.body as unknown }).toEqual({
      status: 503,
      body: UNAVAILABLE,
    });
    t.proximity.failing.clear();

    t.proximity.down = true;
    await reportAccount(v, 'nina').expect(202);
    t.proximity.down = false;

    t.proximity.stalling.add('hasTouchPair');
    await reportAccount(v, 'otto').expect(202);
    t.proximity.stalling.clear();

    expect(await reportRows()).toEqual(
      [m, n, o].map((other) => `${v.user.id}>${other.user.id}:account`).sort(),
    );
    expect(reportedHandles()).toEqual(['mauro', 'nina', 'otto']);
  });

  it('[PROX-65] [X.1 CA1] só M bloqueou V (o sentido que não conta), sem par → o 404 idêntico ao de @ inexistente (status, corpo e cabeçalhos), com as mesmas consultas de um desconhecido; Valkey fora ou lento → o 503 idêntico ao de @ inexistente, excluído e inválido; nada gravado nem enviado; M, que bloqueou, denuncia V → 202', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    await connect(t.database.db, v.user, m.user);
    await blockVia(m, { handle: 'vera' }).expect(204);
    const stranger = await createUser(t.database.db, { handle: 'desconhecida' });
    await createUser(t.database.db, { handle: 'excluida', deletedAt: new Date() });

    const pairChecks = watchPairChecks();
    const blockChecks = vi.spyOn(t.app.get(RelationsRepository), 'hasBlocked');
    const hidden = await reportAccount(v, 'mauro');
    const unknown = await reportAccount(v, 'desconhecida');
    const missing = await reportAccount(v, 'naoexiste');
    expect(hidden.status).toBe(404);
    expect(shape(hidden)).toEqual(shape(missing));
    expect(shape(unknown)).toEqual(shape(missing));
    // M e a desconhecida passam pelas mesmas consultas (o bloqueio, no sentido de V, e o par): o
    // tempo não separa "M bloqueou V" de "sem bloqueio". O @ inexistente consulta só o par.
    expect(blockChecks.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [v.user.id, m.user.id],
      [v.user.id, stranger.id],
    ]);
    expect(pairChecks).toHaveBeenCalledTimes(3);

    t.proximity.failing.add('hasTouchPair');
    const unavailable: Response[] = [];
    for (const handle of ['mauro', 'naoexiste', 'excluida', 'Inválido!']) {
      unavailable.push(await reportAccount(v, handle));
    }
    t.proximity.failing.clear();
    t.proximity.stalling.add('hasTouchPair');
    unavailable.push(await reportAccount(v, 'mauro'));
    t.proximity.stalling.clear();
    expect(unavailable[0]!.status).toBe(503);
    expect(unavailable[0]!.body).toEqual(UNAVAILABLE);
    for (const [index, response] of unavailable.entries()) {
      expect({ index, ...shape(response) }).toEqual({ index, ...shape(unavailable[0]!) });
    }
    expect(pairChecks).toHaveBeenCalledTimes(3 + 5);
    expect(await t.database.db.select().from(reports)).toEqual([]);
    expect(reportEmails()).toEqual([]);

    // O sentido que conta: M bloqueou V e denuncia V → 202.
    await reportAccount(m, 'vera').expect(202);
    expect(await reportRows()).toEqual([`${m.user.id}>${v.user.id}:account`]);
  });

  it('[PROX-65] bloqueio nos dois sentidos (pelo par, PROX-61) e, 60 s depois, com o Valkey fora → V e M denunciam um ao outro (202)', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    await touch(t, v, m);
    await blockVia(v, { handle: 'mauro' }).expect(204);
    await blockVia(m, { handle: 'vera' }).expect(204);
    t.clock.advance(PAIR_MS);
    expect(await hasPair(v, m)).toBe(false);

    t.proximity.failing.add('hasTouchPair');
    await reportAccount(v, 'mauro').expect(202);
    await reportAccount(m, 'vera').expect(202);
    t.proximity.failing.clear();
    expect(await reportRows()).toEqual(
      [`${v.user.id}>${m.user.id}:account`, `${m.user.id}>${v.user.id}:account`].sort(),
    );
    expect(reportedHandles()).toEqual(['mauro', 'vera']);
  });

  it('[PROX-65] [X.1 CA1] depois do desbloqueio, sem par → o 404 idêntico ao de @ inexistente de novo (e, com o Valkey fora, o 503 idêntico), nada gravado; a denúncia feita antes do desbloqueio não abre a porta', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const n = await person(t, 'nina');
    for (const other of [m, n]) {
      await connect(t.database.db, v.user, other.user);
      await blockVia(v, { handle: other.user.handle }).expect(204);
    }
    await reportAccount(v, 'nina').expect(202);
    await unblockVia(v, 'mauro');
    await unblockVia(v, 'nina');
    expect(await blockedBy(v)).toEqual([]);

    for (const handle of ['mauro', 'nina']) {
      const response = await reportAccount(v, handle);
      const missing = await reportAccount(v, 'naoexiste');
      expect({ handle, status: response.status }).toEqual({ handle, status: 404 });
      expect({ handle, ...shape(response) }).toEqual({ handle, ...shape(missing) });
    }
    t.proximity.failing.add('hasTouchPair');
    const down = await reportAccount(v, 'mauro');
    const downMissing = await reportAccount(v, 'naoexiste');
    t.proximity.failing.clear();
    expect(down.status).toBe(503);
    expect(shape(down)).toEqual(shape(downMissing));
    expect(await reportRows()).toEqual([`${v.user.id}>${n.user.id}:account`]);
    expect(reportedHandles()).toEqual(['nina']);
  });

  it('[PROX-65] [X.1 CA1] M, que V bloqueou, excluiu a conta (a linha em blocks continua) → o 404 idêntico ao de @ inexistente; com o Valkey fora, o 503 idêntico; nada gravado nem enviado', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    await connect(t.database.db, v.user, m.user);
    await blockVia(v, { handle: 'mauro' }).expect(204);
    await softDelete(m);
    expect(await blockedBy(v)).toEqual([m.user.id]);

    const gone = await reportAccount(v, 'mauro');
    const missing = await reportAccount(v, 'naoexiste');
    expect(gone.status).toBe(404);
    expect(shape(gone)).toEqual(shape(missing));
    t.proximity.failing.add('hasTouchPair');
    const down = await reportAccount(v, 'mauro');
    const downMissing = await reportAccount(v, 'naoexiste');
    t.proximity.failing.clear();
    expect(down.status).toBe(503);
    expect(shape(down)).toEqual(shape(downMissing));
    expect(await t.database.db.select().from(reports)).toEqual([]);
    expect(reportEmails()).toEqual([]);
  });

  it('[PROX-65] [PERM-14] post e comentário de M, que V bloqueou, não ganham a regra: o 404 idêntico ao de inexistente, também com o Valkey fora, nada gravado; a conta de M, sim (202)', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    await connect(t.database.db, v.user, m.user);
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const creatorPost = await createPost(t.database.db, creator);
    const post = await createPost(t.database.db, m.user, { text: 'post de M' });
    const comment = await addComment(t.database.db, creatorPost, m.user, { body: 'oi da M' });
    // Antes do bloqueio, V vê o post de M e o comentário dele no post da criadora.
    await t.http.get(`/v1/posts/${post.id}`).set(v.headers).expect(200);
    const listed = await t.http
      .get(`/v1/posts/${creatorPost.id}/comments`)
      .set(v.headers)
      .expect(200);
    expect(listed.text).toContain('oi da M');
    await blockVia(v, { handle: 'mauro' }).expect(204);

    t.proximity.failing.add('hasTouchPair');
    for (const [target, missingTarget] of [
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
      const absent = await reportVia(v, missingTarget);
      expect({ target, status: hidden.status }).toEqual({ target, status: 404 });
      expect({ target, ...shape(hidden) }).toEqual({ target, ...shape(absent) });
    }
    expect(await t.database.db.select().from(reports)).toEqual([]);
    // A conta de M, com o mesmo Valkey fora: passa.
    await reportAccount(v, 'mauro').expect(202);
    t.proximity.failing.clear();
    expect(await reportRows()).toEqual([`${v.user.id}>${m.user.id}:account`]);
  });

  it('[PROX-65] [PROX-61] regressão: o bloqueio (POST /me/blocks) não ganha a regra; V bloqueia de novo quem já bloqueou: Valkey fora ou lento → o 503 idêntico ao de @ inexistente (a denúncia, na mesma hora, passa); sem par → o 204 do A-05, consultando o Valkey, sem linha nova', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    await connect(t.database.db, v.user, m.user);
    await blockVia(v, { handle: 'mauro' }).expect(204);

    t.proximity.failing.add('hasTouchPair');
    const again = await blockVia(v, { handle: 'mauro' });
    const missing = await blockVia(v, { handle: 'naoexiste' });
    expect({ status: again.status, body: again.body as unknown }).toEqual({
      status: 503,
      body: UNAVAILABLE,
    });
    expect(shape(again)).toEqual(shape(missing));
    await reportAccount(v, 'mauro').expect(202);
    t.proximity.failing.clear();
    t.proximity.stalling.add('hasTouchPair');
    expect(shape(await blockVia(v, { handle: 'mauro' }))).toEqual(shape(missing));
    t.proximity.stalling.clear();

    const pairChecks = watchPairChecks();
    const quiet = await blockVia(v, { handle: 'mauro' });
    const quietMissing = await blockVia(v, { handle: 'naoexiste' });
    expect(quiet.status).toBe(204);
    expect(shape(quiet)).toEqual(shape(quietMissing));
    expect(pairChecks).toHaveBeenCalledTimes(2);
    expect(await blockedBy(v)).toEqual([m.user.id]);
  });

  it('[PROX-65] [X.1] criadores: V bloqueia uma criadora que via e a denuncia depois; uma criadora bloqueia um fã pelo comentário (o perfil pessoal dele ela não vê: antes, o 404 de inexistente) e denuncia a conta; as duas → 202 com o Valkey fora', async () => {
    const v = await person(t, 'vera');
    const creator = await createUser(t.database.db, { accountType: 'creator', handle: 'criadora' });
    await blockVia(v, { handle: 'criadora' }).expect(204);
    await t.http.get('/v1/users/criadora').set(v.headers).expect(404);

    const k: Person = await directUser(t.app, t.database.db, {
      accountType: 'creator',
      handle: 'kika',
    });
    const fan = await person(t, 'fa_kika');
    const kPost = await createPost(t.database.db, k.user);
    const fanComment = await addComment(t.database.db, kPost, fan.user);
    const before = await reportAccount(k, 'fa_kika');
    const missing = await reportAccount(k, 'naoexiste');
    expect(before.status).toBe(404);
    expect(shape(before)).toEqual(shape(missing));
    await blockVia(k, { commentId: fanComment.id }).expect(204);
    expect(await blockedBy(k)).toEqual([fan.user.id]);

    t.proximity.failing.add('hasTouchPair');
    await reportAccount(v, 'criadora').expect(202);
    await reportAccount(k, 'fa_kika').expect(202);
    t.proximity.failing.clear();
    expect(await reportRows()).toEqual(
      [`${v.user.id}>${creator.id}:account`, `${k.user.id}>${fan.user.id}:account`].sort(),
    );
    expect(reportedHandles()).toEqual(['criadora', 'fa_kika']);
  });
});
