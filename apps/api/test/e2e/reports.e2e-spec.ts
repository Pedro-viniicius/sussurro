// E2E das denúncias e da fila de moderação mínima por e-mail (X.1, D5).
import { reports } from '@sussurro/db';
import { addComment, block, connect, createPost, createUser } from '@sussurro/db/testing';
import { ErrorResponseSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEV_MODERATION_EMAIL } from '../../src/modules/reports/reports.service.js';
import { directUser } from '../support/auth.js';
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
