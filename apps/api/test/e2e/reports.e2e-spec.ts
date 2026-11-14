// E2E das denúncias e da fila de moderação mínima por e-mail (X.1, D5).
import { connectionRequests, reports } from '@sussurro/db';
import { addComment, block, connect, createPost, createUser } from '@sussurro/db/testing';
import { CONNECTION_REQUEST_MODERATION_WINDOW_S, ErrorResponseSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEV_MODERATION_EMAIL } from '../../src/modules/reports/reports.service.js';
import { directUser } from '../support/auth.js';
import { pendingRequest, person, renewSession } from '../support/proximity.js';
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

const MISSING_ID = '01a189e0-af57-7000-85fe-2054e618fea6';

function account(options: Parameters<typeof createUser>[1] = {}) {
  return directUser(t.app, t.database.db, options);
}

function report(headers: Record<string, string>, body: object) {
  return t.http.post('/v1/reports').set(headers).send(body);
}

describe('POST /reports (X.1)', () => {
  it('X.1 CA1: post, comentário e conta visíveis → 202 sem corpo, denúncia gravada e e-mail para a moderação; a pessoa denunciada não recebe nada', async () => {
    const reporter = await account({ handle: 'helena' });
    const friend = await account({ handle: 'caio.r', email: 'caio@example.com' });
    await connect(t.database.db, reporter.user, friend.user);
    const post = await createPost(t.database.db, friend.user, { text: 'post denunciado' });
    const comment = await addComment(t.database.db, post, friend.user);

    const targets = [
      { target: { type: 'post', id: post.id }, reason: 'spam' },
      {
        target: { type: 'comment', id: comment.id },
        reason: 'harassment',
        details: ' Me ofendeu. ',
      },
      { target: { type: 'account', handle: 'Caio.R' }, reason: 'impersonation' },
    ];
    for (const body of targets) {
      const response = await report(reporter.headers, body);
      expect(response.status).toBe(202);
      expect(response.text).toBe('');
    }

    const rows = await t.database.db.select().from(reports);
    expect(rows.map((row) => [row.targetType, row.reason, row.details]).sort()).toEqual(
      [
        ['account', 'impersonation', null],
        ['comment', 'harassment', 'Me ofendeu.'],
        ['post', 'spam', null],
      ].sort(),
    );
    expect(rows.every((row) => row.reporterId === reporter.user.id)).toBe(true);
    expect(rows.every((row) => row.targetUserId === friend.user.id)).toBe(true);
    expect(rows.find((row) => row.targetType === 'post')?.postId).toBe(post.id);
    expect(rows.find((row) => row.targetType === 'comment')?.commentId).toBe(comment.id);

    // Um e-mail por denúncia, só para a moderação; nada para quem foi denunciado.
    expect(t.outbox.sent.map((message) => message.to)).toEqual([
      MODERATION,
      MODERATION,
      MODERATION,
    ]);
    expect(t.outbox.sent.some((message) => message.to === 'caio@example.com')).toBe(false);
    const commentEmail = t.outbox.sent.find((message) => message.subject.includes('comentário'))!;
    expect(commentEmail.subject).toContain('Assédio ou bullying');
    expect(commentEmail.text).toContain(`comentário ${comment.id} de @caio.r`);
    expect(commentEmail.text).toContain('Detalhes: Me ofendeu.');
    // Minimização: o e-mail não traz quem denunciou nem o conteúdo denunciado.
    for (const message of t.outbox.sent) {
      expect(message.text).not.toContain('helena');
      expect(message.text).not.toContain('post denunciado');
    }
  });

  it('X.1 CA1: o que a pessoa não vê → 404 idêntico ao de inexistente; nada gravado nem enviado', async () => {
    const reporter = await account();
    const stranger = await createUser(t.database.db, { handle: 'desconhecida' });
    const strangerPost = await createPost(t.database.db, stranger);
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const creatorPost = await createPost(t.database.db, creator);
    const strangerComment = await addComment(t.database.db, strangerPost, stranger);
    const blockedAuthor = await createUser(t.database.db);
    const hiddenComment = await addComment(t.database.db, creatorPost, blockedAuthor);
    await block(t.database.db, blockedAuthor, reporter.user);

    const cases: [object, object][] = [
      [
        { type: 'post', id: strangerPost.id },
        { type: 'post', id: MISSING_ID },
      ],
      [
        { type: 'comment', id: strangerComment.id },
        { type: 'comment', id: MISSING_ID },
      ],
      [
        { type: 'comment', id: hiddenComment.id },
        { type: 'comment', id: MISSING_ID },
      ],
      [
        { type: 'account', handle: 'desconhecida' },
        { type: 'account', handle: 'naoexiste' },
      ],
      [
        { type: 'account', handle: blockedAuthor.handle },
        { type: 'account', handle: 'naoexiste' },
      ],
    ];
    for (const [target, missingTarget] of cases) {
      const response = await report(reporter.headers, { target, reason: 'spam' });
      const missing = await report(reporter.headers, { target: missingTarget, reason: 'spam' });
      expect({ target, status: response.status, body: response.body as unknown }).toEqual({
        target,
        status: 404,
        body: missing.body as unknown,
      });
    }
    expect(await t.database.db.select().from(reports)).toHaveLength(0);
    expect(t.outbox.sent).toHaveLength(0);
  });

  it('X.1: repetir a denúncia do mesmo alvo é idempotente (202, uma linha, um e-mail)', async () => {
    const reporter = await account();
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, creator);
    for (const reason of ['spam', 'hate', 'spam']) {
      expect(
        (await report(reporter.headers, { target: { type: 'post', id: post.id }, reason })).status,
      ).toBe(202);
    }
    expect(await t.database.db.select().from(reports)).toHaveLength(1);
    expect(t.outbox.sent).toHaveLength(1);
    // Outro alvo (a conta) é outra denúncia.
    await report(reporter.headers, {
      target: { type: 'account', handle: creator.handle },
      reason: 'spam',
    }).then((response) => {
      expect(response.status).toBe(202);
    });
    expect(await t.database.db.select().from(reports)).toHaveLength(2);
  });

  it('X.1: o próprio conteúdo → 400; motivo fora da lista, detalhes acima de 500 ou campo a mais → 400', async () => {
    const reporter = await account({ handle: 'eu_mesma' });
    const own = await createPost(t.database.db, reporter.user);
    for (const target of [
      { type: 'post', id: own.id },
      { type: 'account', handle: 'eu_mesma' },
    ]) {
      const response = await report(reporter.headers, { target, reason: 'spam' });
      expect(response.status).toBe(400);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
    }
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, creator);
    for (const body of [
      { target: { type: 'post', id: post.id }, reason: 'outro' },
      { target: { type: 'post', id: post.id }, reason: 'spam', details: 'x'.repeat(501) },
      { target: { type: 'post', id: post.id }, reason: 'spam', reporterId: MISSING_ID },
      { target: { type: 'user', id: post.id }, reason: 'spam' },
    ]) {
      expect((await report(reporter.headers, body)).status).toBe(400);
    }
    expect(await t.database.db.select().from(reports)).toHaveLength(0);
  });

  it('X.1: criador também denuncia (comentário no próprio post); rate limit de 20 por hora → 429', async () => {
    const creator = await account({ accountType: 'creator' });
    const post = await createPost(t.database.db, creator.user);
    const fan = await createUser(t.database.db);
    const comment = await addComment(t.database.db, post, fan);
    expect(
      (
        await report(creator.headers, {
          target: { type: 'comment', id: comment.id },
          reason: 'hate',
        })
      ).status,
    ).toBe(202);
    for (let index = 0; index < 19; index++) {
      expect(
        (
          await report(creator.headers, {
            target: { type: 'post', id: MISSING_ID },
            reason: 'spam',
          })
        ).status,
      ).toBe(404);
    }
    const limited = await report(creator.headers, {
      target: { type: 'comment', id: comment.id },
      reason: 'hate',
    });
    expect(limited.status).toBe(429);
    expect(ErrorResponseSchema.parse(limited.body).code).toBe('RATE_LIMITED');
  });
});

describe('denunciar a conta de quem você bloqueou (R1-PO-1, aprovada pelo PO em 2026-10-30)', () => {
  it('[PROX-65] [X.1] V bloqueou M → 202 e gravada, também com o Valkey fora (a denúncia não depende dele, ADR 0013); bloqueio nos dois sentidos também', async () => {
    const v = await account({ handle: 'vera' });
    const m = await account({ handle: 'mauro' });
    await connect(t.database.db, v.user, m.user);
    await t.http.post('/v1/me/blocks').set(v.headers).send({ handle: 'mauro' }).expect(204);
    await t.http.get('/v1/users/mauro').set(v.headers).expect(404);
    await block(t.database.db, m.user, v.user);
    t.proximity.down = true;
    const response = await report(v.headers, {
      target: { type: 'account', handle: 'mauro' },
      reason: 'harassment',
    });
    expect(response.status).toBe(202);
    const rows = await t.database.db.select().from(reports);
    expect(rows.map((row) => [row.reporterId, row.targetUserId, row.targetType])).toEqual([
      [v.user.id, m.user.id, 'account'],
    ]);
  });

  it('[PROX-65] [X.1 CA1] só M bloqueou V, ou depois do desbloqueio → o 404 idêntico ao de @ inexistente, nada gravado; Valkey fora não muda (sem 503)', async () => {
    const v = await account({ handle: 'vera' });
    const m = await createUser(t.database.db, { handle: 'mauro' });
    const n = await createUser(t.database.db, { handle: 'nina' });
    await block(t.database.db, m, v.user);
    // V bloqueou N e desbloqueou: a regra R1-PO-1 não vale mais.
    await block(t.database.db, v.user, n);
    await t.http.delete('/v1/me/blocks/nina').set(v.headers).expect(204);
    t.proximity.down = true;
    for (const handle of ['mauro', 'nina']) {
      const response = await report(v.headers, {
        target: { type: 'account', handle },
        reason: 'spam',
      });
      const missing = await report(v.headers, {
        target: { type: 'account', handle: 'naoexiste' },
        reason: 'spam',
      });
      expect({ handle, status: response.status, body: response.body as unknown }).toEqual({
        handle,
        status: 404,
        body: missing.body as unknown,
      });
    }
    expect(await t.database.db.select().from(reports)).toHaveLength(0);
  });

  it('[PROX-65] [PERM-14] post de M, que V bloqueou, não ganha a regra: o 404 de inexistente', async () => {
    const v = await account({ handle: 'vera' });
    const m = await account({ handle: 'mauro' });
    await connect(t.database.db, v.user, m.user);
    const post = await createPost(t.database.db, m.user);
    await t.http.post('/v1/me/blocks').set(v.headers).send({ handle: 'mauro' }).expect(204);
    const response = await report(v.headers, {
      target: { type: 'post', id: post.id },
      reason: 'spam',
    });
    expect(response.status).toBe(404);
    expect(await t.database.db.select().from(reports)).toHaveLength(0);
  });
});

describe('denunciar a outra pessoa de um pedido de conexão das últimas 24 h (ADR 0013)', () => {
  const WINDOW_MS = CONNECTION_REQUEST_MODERATION_WINDOW_S * 1000;

  function reportAccount(headers: Record<string, string>, handle: string) {
    return report(headers, { target: { type: 'account', handle }, reason: 'harassment' });
  }

  async function reportPairs() {
    const rows = await t.database.db.select().from(reports);
    return rows.map((row) => [row.reporterId, row.targetUserId, row.targetType]);
  }

  it('[NFC-MOD-20] A pede para B: B denuncia A e A denuncia B (202, gravadas, sem depender do Valkey); o terceiro C recebe o 404 de @ inexistente', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    const marina = await person(t, 'marina');
    await pendingRequest(t, helena, caio);
    t.proximity.down = true;

    const missing = await reportAccount(marina.headers, 'naoexiste');
    expect(missing.status).toBe(404);
    for (const handle of ['helena', 'caio.r']) {
      const response = await reportAccount(marina.headers, handle);
      expect({ handle, status: response.status, body: response.body as unknown }).toEqual({
        handle,
        status: 404,
        body: missing.body as unknown,
      });
    }
    expect(await reportPairs()).toEqual([]);

    expect((await reportAccount(caio.headers, 'helena')).status).toBe(202);
    expect((await reportAccount(helena.headers, 'caio.r')).status).toBe(202);
    expect((await reportPairs()).sort()).toEqual(
      [
        [caio.user.id, helena.user.id, 'account'],
        [helena.user.id, caio.user.id, 'account'],
      ].sort(),
    );
  });

  it('[NFC-MOD-21] B bloqueia A pelo pedido e depois denuncia: as duas ações gravam', async () => {
    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    await pendingRequest(t, helena, caio);
    await t.http.post('/v1/me/blocks').set(caio.headers).send({ handle: 'helena' }).expect(204);
    expect((await reportAccount(caio.headers, 'helena')).status).toBe(202);
    expect(await reportPairs()).toEqual([[caio.user.id, helena.user.id, 'account']]);
  });

  it('[NFC-MOD-22] pedido de 24 h ou mais (gravado no banco ou envelhecido pelo relógio): o 404 de @ inexistente, nada gravado', async () => {
    const v = await account({ handle: 'vera' });
    const old = await createUser(t.database.db, { handle: 'antiga' });
    const createdAt = new Date(t.clock.now().getTime() - WINDOW_MS - 1_000);
    await t.database.db.insert(connectionRequests).values({
      fromId: old.id,
      toId: v.user.id,
      method: 'nfc',
      status: 'expired',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 120_000),
      respondedAt: new Date(createdAt.getTime() + 120_000),
    });
    const missing = await reportAccount(v.headers, 'naoexiste');
    const response = await reportAccount(v.headers, 'antiga');
    expect({ status: response.status, body: response.body as unknown }).toEqual({
      status: 404,
      body: missing.body as unknown,
    });

    const helena = await person(t, 'helena');
    const caio = await person(t, 'caio.r');
    await pendingRequest(t, helena, caio);
    t.clock.advance(WINDOW_MS);
    await renewSession(t, caio);
    expect((await reportAccount(caio.headers, 'helena')).status).toBe(404);
    expect(await reportPairs()).toEqual([]);
  });
});

describe('MODERATION_EMAIL ausente fora de produção', () => {
  it('o e-mail vai para o endereço de desenvolvimento (só aparece no log com EMAIL_SENDER=log)', async () => {
    const dev = await createTestApp();
    try {
      const reporter = await directUser(dev.app, dev.database.db);
      const creator = await createUser(dev.database.db, { accountType: 'creator' });
      await dev.http
        .post('/v1/reports')
        .set(reporter.headers)
        .send({ target: { type: 'account', handle: creator.handle }, reason: 'other' })
        .expect(202);
      expect(dev.outbox.sent.map((message) => message.to)).toEqual([DEV_MODERATION_EMAIL]);
    } finally {
      await dev.close();
    }
  });
});
