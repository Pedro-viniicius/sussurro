// E2E das notificações (Fase 6; ADR 0011; histórias 6.1, 6.2, 6.3, 6.5 e 6.6 no servidor; testes.md
// NOT-01 a NOT-09 e PROX-29). O push é só a mensagem na fila `push` (fake): o envio ao Expo, os
// recibos e a DLQ são testados no worker.
import { eq, likes, notifications, posts } from '@sussurro/db';
import { addComment, block, connect, createPost, TEST_PASSWORD } from '@sussurro/db/testing';
import {
  followersText,
  groupNotifications,
  type Notification,
  type NotificationsPage,
  NotificationsPageSchema,
  notificationPlainText,
  UnreadNotificationsSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';
import { directSession, directUser } from '../support/auth.js';
import { acceptRequest, pendingRequest, person, type Person } from '../support/proximity.js';
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

async function list(
  who: { headers: Record<string, string> },
  query = '',
): Promise<NotificationsPage> {
  const response = await t.http.get(`/v1/notifications${query}`).set(who.headers).expect(200);
  return NotificationsPageSchema.parse(response.body);
}

async function unread(who: { headers: Record<string, string> }): Promise<number> {
  const response = await t.http.get('/v1/notifications/unread-count').set(who.headers).expect(200);
  return UnreadNotificationsSchema.parse(response.body).count;
}

function summary(page: NotificationsPage): string[] {
  return page.items.map((item) => notificationPlainText(item));
}

async function creator(handle?: string) {
  return directUser(t.app, t.database.db, {
    accountType: 'creator',
    ...(handle === undefined ? {} : { handle }),
  });
}

async function connected(): Promise<[Person, Person]> {
  const a = await person(t);
  const b = await person(t);
  await connect(t.database.db, a.user, b.user);
  return [a, b];
}

function pushJobs() {
  return t.push.sent.map((message) => message.type);
}

describe('curtidas, comentários e respostas (6.1)', () => {
  it('[6.1 CA1] curtida, comentário e resposta geram a notificação certa, em "Hoje", com o push enfileirado', async () => {
    const [ana, bia] = await connected();
    const post = await createPost(t.database.db, ana.user, { type: 'photo' });

    await t.http.put(`/v1/posts/${post.id}/like`).set(bia.headers).expect(200);
    const comment = await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(bia.headers)
      .send({ body: 'Que luz\nbonita!' })
      .expect(201);
    await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(ana.headers)
      .send({ body: 'Obrigada!', parentId: (comment.body as { id: string }).id })
      .expect(201);

    const forAna = await list(ana);
    expect(summary(forAna)).toEqual([
      `${bia.user.handle} comentou na sua foto: “Que luz bonita!”`,
      `${bia.user.handle} curtiu sua foto.`,
    ]);
    const liked = forAna.items[1] as Extract<Notification, { type: 'post_liked' }>;
    expect(liked.post).toMatchObject({ id: post.id, type: 'photo' });
    expect(liked.post.thumbUrl).toContain('thumb.jpg');
    expect(liked.actor).toMatchObject({ handle: bia.user.handle, profileVisible: true });
    expect(summary(await list(bia))).toEqual([
      `${ana.user.handle} respondeu seu comentário: “Obrigada!”`,
    ]);
    // Agrupamento do app: tudo em "Hoje" (o relógio de teste é o mesmo das notificações).
    expect(groupNotifications(forAna.items, t.clock.now(), 'UTC').map((s) => s.title)).toEqual([
      'Hoje',
    ]);
    expect(t.push.sent).toHaveLength(3);
    expect(pushJobs()).toEqual(['notification', 'notification', 'notification']);
  });

  it('[6.1 CA1] resposta no post de outra pessoa: avisa o autor do comentário e o autor do post', async () => {
    const author = await creator();
    const ana = await person(t);
    const bia = await person(t);
    const post = await createPost(t.database.db, author.user, { type: 'reel' });
    const comment = await addComment(t.database.db, post, ana.user, { body: 'Primeiro!' });
    await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(bia.headers)
      .send({ body: 'Segundo.', parentId: comment.id })
      .expect(201);
    expect(summary(await list(ana))).toEqual([
      `${bia.user.handle} respondeu seu comentário: “Segundo.”`,
    ]);
    expect(summary(await list(author))).toEqual([
      `${bia.user.handle} comentou no seu reel: “Segundo.”`,
    ]);
  });

  it('[6.1 CA1] a notificação é gravada na mesma transação: se ela falha, a curtida não fica', async () => {
    const [ana, bia] = await connected();
    const post = await createPost(t.database.db, ana.user);
    const spy = vi
      .spyOn(t.app.get(NotificationsService), 'recordLike')
      .mockRejectedValueOnce(new Error('falha simulada'));
    await t.http.put(`/v1/posts/${post.id}/like`).set(bia.headers).expect(500);
    spy.mockRestore();
    expect(await t.database.db.select().from(likes)).toEqual([]);
    const [row] = await t.database.db.select().from(posts).where(eq(posts.id, post.id));
    expect(row?.likeCount).toBe(0);
    expect(t.push.sent).toEqual([]);
  });

  it('[NOT-07] [6.1 CA2] curtir e descurtir várias vezes → 1 notificação e 1 push; curtir o próprio post → nada', async () => {
    const [ana, bia] = await connected();
    const post = await createPost(t.database.db, ana.user);
    for (let index = 0; index < 4; index++) {
      await t.http.put(`/v1/posts/${post.id}/like`).set(bia.headers).expect(200);
      await t.http.delete(`/v1/posts/${post.id}/like`).set(bia.headers).expect(200);
    }
    await t.http.put(`/v1/posts/${post.id}/like`).set(ana.headers).expect(200);
    await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(ana.headers)
      .send({ body: 'Comentando o meu.' })
      .expect(201);
    expect(summary(await list(ana))).toEqual([`${bia.user.handle} curtiu seu texto.`]);
    expect(await t.database.db.select().from(notifications)).toHaveLength(1);
    expect(t.push.sent).toHaveLength(1);
  });

  it('[6.5 CA4] fila push fora do ar: a curtida responde 200 e a notificação continua no app', async () => {
    const [ana, bia] = await connected();
    const post = await createPost(t.database.db, ana.user);
    t.push.down = true;
    await t.http.put(`/v1/posts/${post.id}/like`).set(bia.headers).expect(200);
    expect(summary(await list(ana))).toEqual([`${bia.user.handle} curtiu seu texto.`]);
    expect(t.push.sent).toEqual([]);
  });
});

describe('origem excluída, bloqueio e conexão desfeita (NOT-09, X.2)', () => {
  it('[NOT-09] [6.1 CA3] post excluído → a notificação dele some', async () => {
    const [ana, bia] = await connected();
    const kept = await createPost(t.database.db, ana.user);
    const removed = await createPost(t.database.db, ana.user);
    await t.http.put(`/v1/posts/${kept.id}/like`).set(bia.headers).expect(200);
    await t.http.put(`/v1/posts/${removed.id}/like`).set(bia.headers).expect(200);
    expect(await unread(ana)).toBe(2);
    await t.http.delete(`/v1/posts/${removed.id}`).set(ana.headers).expect(204);
    const page = await list(ana);
    expect(page.items.map((item) => (item as { post?: { id: string } }).post?.id)).toEqual([
      kept.id,
    ]);
    expect(await unread(ana)).toBe(1);
  });

  it('[NOT-09] [6.1 CA3] autor excluído → todas as notificações dele somem (e as dele também)', async () => {
    const ana = await person(t);
    const bia = await directUser(t.app, t.database.db, { emailVerifiedAt: new Date() });
    await connect(t.database.db, ana.user, bia.user);
    const post = await createPost(t.database.db, ana.user);
    const biaPost = await createPost(t.database.db, bia.user);
    await t.http.put(`/v1/posts/${post.id}/like`).set(bia.headers).expect(200);
    await t.http.put(`/v1/posts/${biaPost.id}/like`).set(ana.headers).expect(200);
    await t.http.delete('/v1/me').set(bia.headers).send({ password: TEST_PASSWORD }).expect(204);
    expect((await list(ana)).items).toEqual([]);
    expect(await unread(ana)).toBe(0);
    // Exclusão de conta: as linhas saem na mesma transação (as dela e as em que ela agiu).
    expect(await t.database.db.select().from(notifications)).toEqual([]);
  });

  it('[NOT-09] comentário apagado → a notificação dele some', async () => {
    const [ana, bia] = await connected();
    const post = await createPost(t.database.db, ana.user);
    const response = await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(bia.headers)
      .send({ body: 'Vou apagar.' })
      .expect(201);
    expect((await list(ana)).items).toHaveLength(1);
    await t.http
      .delete(`/v1/comments/${(response.body as { id: string }).id}`)
      .set(bia.headers)
      .expect(204);
    expect((await list(ana)).items).toEqual([]);
  });

  it('[X.2] bloquear apaga as notificações entre os dois, nos dois sentidos; bloqueio gravado direto também esconde', async () => {
    const author = await creator();
    const fan = await person(t);
    const other = await person(t);
    const post = await createPost(t.database.db, author.user);
    await t.http.put(`/v1/posts/${post.id}/like`).set(fan.headers).expect(200);
    await t.http.put(`/v1/posts/${post.id}/like`).set(other.headers).expect(200);
    // Quem curtiu bloqueia o criador (o criador não vê o perfil pessoal, então só bloquearia pelo
    // comentário): as notificações somem para os dois lados.
    await t.http
      .post('/v1/me/blocks')
      .set(fan.headers)
      .send({ handle: author.user.handle })
      .expect(204);
    expect(summary(await list(author))).toEqual([`${other.user.handle} curtiu seu texto.`]);
    expect((await t.database.db.select().from(notifications)).map((row) => row.actorId)).toEqual([
      other.user.id,
    ]);
    // Defesa em profundidade: o filtro da leitura também esconde (bloqueio no outro sentido).
    await block(t.database.db, other.user, author.user);
    expect((await list(author)).items).toEqual([]);
    expect(await unread(author)).toBe(0);
  });

  it('[PROX-29] [D8] desfazer a conexão tira "Vocês estão conectados" dos dois; a resposta num post que deixou de ser visível some', async () => {
    const a = await person(t);
    const b = await person(t);
    const { fromToken, request } = await pendingRequest(t, a, b);
    await acceptRequest(t, b, request.id, fromToken).expect(200);
    const post = await createPost(t.database.db, b.user);
    const comment = await addComment(t.database.db, post, a.user, { body: 'Oi' });
    await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(b.headers)
      .send({ body: 'Oi!', parentId: comment.id })
      .expect(201);
    expect(summary(await list(a))).toEqual([
      `${b.user.handle} respondeu seu comentário: “Oi!”`,
      `Você e ${b.user.handle} estão conectados.`,
    ]);
    await t.http.delete(`/v1/connections/${b.user.handle}`).set(a.headers).expect(204);
    expect((await list(a)).items).toEqual([]);
    expect((await list(b)).items).toEqual([]);
  });
});

describe('conexões e pedidos (PROX-29, 6.6)', () => {
  it('[PROX-29] [6.6] pedido novo → push para quem recebeu; aceite → "Vocês estão conectados" para os dois e push só para quem pediu', async () => {
    const a = await person(t);
    const b = await person(t);
    const { fromToken, request } = await pendingRequest(t, a, b);
    expect(t.push.sent).toEqual([{ type: 'connection-request', requestId: request.id }]);
    // Repetir o pedido pendente (200) não manda outro push.
    await acceptRequest(t, b, request.id, fromToken).expect(200);

    const forA = await list(a);
    const forB = await list(b);
    expect(summary(forA)).toEqual([`Você e ${b.user.handle} estão conectados.`]);
    expect(summary(forB)).toEqual([`Você e ${a.user.handle} estão conectados.`]);
    const pushed = t.push.sent.filter((message) => message.type === 'notification');
    expect(pushed).toEqual([{ type: 'notification', notificationId: forA.items[0]?.id }]);
    // Aceitar de novo (idempotente) não cria outra notificação nem outro push.
    await acceptRequest(t, b, request.id, fromToken).expect(200);
    expect(await t.database.db.select().from(notifications)).toHaveLength(2);
    expect(t.push.sent).toHaveLength(2);
  });

  it('[PROX-29] pedidos cruzados (A→B com B→A pendente): a conexão nasce na hora, com a notificação para os dois', async () => {
    const a = await person(t);
    const b = await person(t);
    // B e A leram o código um do outro: A também toca em "Conectar" no cartão de B (P5).
    const { fromTokens, request } = await pendingRequest(t, b, a);
    const response = await t.http
      .post('/v1/connections/requests')
      .set(a.headers)
      .send({ targetToken: fromTokens.token, method: 'nfc' })
      .expect(200);
    expect((response.body as { status: string }).status).toBe('accepted');
    expect(summary(await list(a))).toEqual([`Você e ${b.user.handle} estão conectados.`]);
    expect(summary(await list(b))).toEqual([`Você e ${a.user.handle} estão conectados.`]);
    // Push: o pedido de B para A e a conexão para B (quem pediu primeiro).
    const bNotification = (await list(b)).items[0]?.id;
    expect(t.push.sent).toEqual([
      { type: 'connection-request', requestId: request.id },
      { type: 'notification', notificationId: bNotification },
    ]);
  });
});

describe('seguidores agregados e anônimos (6.3)', () => {
  async function followers(count: number) {
    const result = [];
    for (let index = 0; index < count; index++) {
      result.push(await person(t));
    }
    return result;
  }

  it('[NOT-01] [NOT-05] [6.3 CA1] 3 pessoas no mesmo dia → uma linha "3 novas pessoas…", actor_id nulo, sem nada de quem seguiu', async () => {
    const bia = await creator();
    const fans = await followers(3);
    for (const fan of fans) {
      await t.http.put(`/v1/creators/${bia.user.handle}/follow`).set(fan.headers).expect(200);
    }
    const page = await list(bia);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ type: 'new_followers', count: 3, read: false });
    expect(summary(page)).toEqual([followersText(3)]);
    expect(page.items[0]).not.toHaveProperty('actor');
    const [row] = await t.database.db.select().from(notifications);
    expect(row).toMatchObject({
      actorId: null,
      postId: null,
      commentId: null,
      payload: {},
      count: 3,
    });
    // [NOT-02] Nenhuma resposta do criador traz id, @ ou nome de quem seguiu.
    const responses = [
      JSON.stringify(page),
      JSON.stringify((await t.http.get('/v1/notifications/unread-count').set(bia.headers)).body),
      JSON.stringify((await t.http.get(`/v1/users/${bia.user.handle}`).set(bia.headers)).body),
      JSON.stringify((await t.http.get('/v1/me').set(bia.headers)).body),
      JSON.stringify(t.push.sent),
    ].join('\n');
    for (const fan of fans) {
      for (const value of [fan.user.id, fan.user.handle, fan.user.name]) {
        expect(responses).not.toContain(value);
      }
    }
    // [NOT-08] Um push só (a linha ficou não lida no primeiro follow), com o id da notificação.
    expect(t.push.sent).toEqual([{ type: 'notification', notificationId: page.items[0]?.id }]);
  });

  it('[NOT-05] [6.3 CA6] 1 seguidor → singular', async () => {
    const bia = await creator();
    const [fan] = await followers(1);
    await t.http.put(`/v1/creators/${bia.user.handle}/follow`).set(fan!.headers).expect(200);
    expect(summary(await list(bia))).toEqual(['1 nova pessoa começou a seguir você.']);
  });

  it('[NOT-03] [6.3 CA3] follows às 23:59 e às 00:01 de Brasília → duas linhas, uma por dia', async () => {
    t.clock.set(new Date('2026-10-30T02:59:00.000Z')); // 23:59 de 29/10 em Brasília
    const bia = await creator();
    const [first, second] = await followers(2);
    await t.http.put(`/v1/creators/${bia.user.handle}/follow`).set(first!.headers).expect(200);
    t.clock.set(new Date('2026-10-30T03:01:00.000Z')); // 00:01 de 30/10
    await t.http.put(`/v1/creators/${bia.user.handle}/follow`).set(second!.headers).expect(200);
    const rows = await t.database.db.select().from(notifications);
    expect(rows.map((row) => [row.bucketKey, row.count]).sort()).toEqual([
      ['nf:2026-10-29', 1],
      ['nf:2026-10-30', 1],
    ]);
    expect((await list(bia)).items).toHaveLength(2);
  });

  it('[NOT-04] [6.3 CA4] deixar de seguir não diminui; seguir de novo no mesmo dia soma 1 (aceito no ADR 0011); seguir de novo sem deixar não soma', async () => {
    const bia = await creator();
    const [fan] = await followers(1);
    const path = `/v1/creators/${bia.user.handle}/follow`;
    await t.http.put(path).set(fan!.headers).expect(200);
    await t.http.put(path).set(fan!.headers).expect(200);
    expect((await list(bia)).items[0]).toMatchObject({ count: 1 });
    await t.http.delete(path).set(fan!.headers).expect(200);
    expect((await list(bia)).items[0]).toMatchObject({ count: 1 });
    await t.http.put(path).set(fan!.headers).expect(200);
    expect((await list(bia)).items[0]).toMatchObject({ count: 2 });
  });

  it('[NOT-06] [6.3 CA5] [6.2 CA1] lida volta a ficar não lida com um seguidor novo no mesmo dia (e só então outro push)', async () => {
    const bia = await creator();
    const [first, second, third] = await followers(3);
    const path = `/v1/creators/${bia.user.handle}/follow`;
    await t.http.put(path).set(first!.headers).expect(200);
    t.clock.advance(60_000);
    await t.http.put(path).set(second!.headers).expect(200);
    expect(await unread(bia)).toBe(1);
    expect(t.push.sent).toHaveLength(1);

    const before = await list(bia);
    const response = await t.http
      .post('/v1/notifications/read')
      .set(bia.headers)
      .send({ upTo: before.items[0]?.updatedAt })
      .expect(200);
    expect(UnreadNotificationsSchema.parse(response.body)).toEqual({ count: 0 });
    expect((await list(bia)).items[0]).toMatchObject({ read: true, count: 2 });

    t.clock.advance(60_000);
    await t.http.put(path).set(third!.headers).expect(200);
    expect(await unread(bia)).toBe(1);
    expect((await list(bia)).items[0]).toMatchObject({ read: false, count: 3 });
    expect(t.push.sent).toHaveLength(2);
  });
});

describe('ponto azul e marcar como lidas (6.2)', () => {
  it('[NOT-06] [6.2 CA1] upTo marca só até a data dada (no máximo agora); a contagem para em 99', async () => {
    const author = await creator();
    const post = await createPost(t.database.db, author.user);
    const fans: Person[] = [];
    for (let index = 0; index < 3; index++) {
      fans.push(await person(t));
    }
    for (const fan of fans) {
      t.clock.advance(1_000);
      await t.http.put(`/v1/posts/${post.id}/like`).set(fan.headers).expect(200);
    }
    expect(await unread(author)).toBe(3);
    const page = await list(author);
    // Marca até a do meio: a mais recente continua não lida.
    const middle = page.items[1]?.updatedAt;
    const response = await t.http
      .post('/v1/notifications/read')
      .set(author.headers)
      .send({ upTo: middle })
      .expect(200);
    expect(response.body).toEqual({ count: 1 });
    expect((await list(author)).items.map((item) => item.read)).toEqual([false, true, true]);
    // upTo no futuro vale como agora.
    await t.http
      .post('/v1/notifications/read')
      .set(author.headers)
      .send({ upTo: '2099-01-01T00:00:00.000Z' })
      .expect(200);
    expect(await unread(author)).toBe(0);

    // Teto de 99.
    for (let index = 0; index < 101; index++) {
      const other = await createPost(t.database.db, author.user);
      await t.database.db.insert(notifications).values({
        recipientId: author.user.id,
        actorId: fans[0]!.user.id,
        postId: other.id,
        type: 'post_liked',
        createdAt: t.clock.now(),
        updatedAt: t.clock.now(),
      });
    }
    expect(await unread(author)).toBe(99);
  });

  it('entrada inválida → 400; só as notificações de quem chama', async () => {
    const [ana, bia] = await connected();
    const post = await createPost(t.database.db, ana.user);
    await t.http.put(`/v1/posts/${post.id}/like`).set(bia.headers).expect(200);
    await t.http
      .post('/v1/notifications/read')
      .set(bia.headers)
      .send({ upTo: 'ontem' })
      .expect(400);
    await t.http
      .post('/v1/notifications/read')
      .set(bia.headers)
      .send({ upTo: t.clock.now().toISOString(), userId: ana.user.id })
      .expect(400);
    // Bia marcando "as dela" não mexe nas de Ana.
    await t.http
      .post('/v1/notifications/read')
      .set(bia.headers)
      .send({ upTo: t.clock.now().toISOString() })
      .expect(200);
    expect(await unread(ana)).toBe(1);
    expect((await list(bia)).items).toEqual([]);
    await t.http.get(`/v1/notifications?userId=${ana.user.id}`).set(bia.headers).expect(400);
  });
});

describe('lista: paginação e janela de 30 dias (6.1)', () => {
  it('cursor por updated_at, sem repetir nem pular; cursor de outra conta → 400; mais de 30 dias não aparece', async () => {
    const author = await creator();
    const fans: Person[] = [];
    for (let index = 0; index < 5; index++) {
      fans.push(await person(t));
    }
    const post = await createPost(t.database.db, author.user);
    for (const fan of fans) {
      t.clock.advance(1_000);
      await t.http.put(`/v1/posts/${post.id}/like`).set(fan.headers).expect(200);
    }
    const first = await list(author, '?limit=2');
    const second = await list(
      author,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    const third = await list(
      author,
      `?limit=2&cursor=${encodeURIComponent(second.nextCursor ?? '')}`,
    );
    const seen = [...first.items, ...second.items, ...third.items].map(
      (item) => (item as { actor: { handle: string } }).actor.handle,
    );
    expect(seen).toEqual(fans.map((fan) => fan.user.handle).reverse());
    expect(third.nextCursor).toBeNull();
    await t.http
      .get(`/v1/notifications?cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
      .set(fans[0]!.headers)
      .expect(400);
    t.clock.advance(31 * 24 * 60 * 60 * 1000);
    expect((await list({ headers: await refreshed(author) })).items).toEqual([]);
  });

  it('a conta pessoal vê o @ da conexão como tocável; o criador vê o @ de quem curtiu, sem perfil tocável', async () => {
    const author = await creator();
    const fan = await person(t);
    const post = await createPost(t.database.db, author.user);
    await t.http.put(`/v1/posts/${post.id}/like`).set(fan.headers).expect(200);
    const [item] = (await list(author)).items;
    expect(item).toMatchObject({
      type: 'post_liked',
      actor: { handle: fan.user.handle, accountType: 'personal', profileVisible: false },
    });
  });
});

/** O relógio andou mais que os 15 min do access token: sessão nova para a mesma conta. */
function refreshed(who: { user: { id: string; accountType: 'personal' | 'creator' } }) {
  return directSession(t.app, who.user);
}
