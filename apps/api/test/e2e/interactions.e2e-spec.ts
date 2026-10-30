// E2E de curtidas e comentários (histórias 2.7 e 2.8; D11, A-06, A-13; testes.md §6.1 e §6.2).
import { comments, eq, likes, posts } from '@sussurro/db';
import { addComment, addLike, connect, createPost, createUser } from '@sussurro/db/testing';
import {
  type CommentsPage,
  CommentSchema,
  CommentsPageSchema,
  ErrorResponseSchema,
  LikeStateSchema,
  PostSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { directSession, signedInUser } from '../support/auth.js';
import { createTextPostViaApi, verifiedUser } from '../support/posts.js';
import { listRoutes } from '../support/routes.js';
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

const NOT_FOUND_POST = { code: 'NOT_FOUND', message: 'Publicação não encontrada' };

async function postRow(id: string) {
  const [row] = await t.database.db.select().from(posts).where(eq(posts.id, id));
  return row!;
}

async function listComments(headers: Record<string, string>, postId: string, query = '') {
  const response = await t.http
    .get(`/v1/posts/${postId}/comments${query}`)
    .set(headers)
    .expect(200);
  return CommentsPageSchema.parse(response.body);
}

function flatten(page: CommentsPage) {
  return page.items.flatMap((item) => [item, ...item.replies]);
}

describe('curtir (2.7)', () => {
  it('[CNT-04] curtir 2 vezes = 1 curtida; descurtir sem ter curtido não fica negativo', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, author);
    const { headers } = await signedInUser(t.http, t.database.db);

    const unliked = await t.http.delete(`/v1/posts/${post.id}/like`).set(headers).expect(200);
    expect(LikeStateSchema.parse(unliked.body)).toEqual({ likeCount: 0, likedByMe: false });
    for (let index = 0; index < 2; index++) {
      const liked = await t.http.put(`/v1/posts/${post.id}/like`).set(headers).expect(200);
      expect(liked.body).toEqual({ likeCount: 1, likedByMe: true });
    }
    expect(await t.database.db.select().from(likes)).toHaveLength(1);
    const view = await t.http.get(`/v1/posts/${post.id}`).set(headers).expect(200);
    expect(PostSchema.parse(view.body)).toMatchObject({ likeCount: 1, likedByMe: true });

    await t.http.delete(`/v1/posts/${post.id}/like`).set(headers).expect(200);
    const again = await t.http.delete(`/v1/posts/${post.id}/like`).set(headers).expect(200);
    expect(again.body).toEqual({ likeCount: 0, likedByMe: false });
    expect((await postRow(post.id)).likeCount).toBe(0);
  });

  it('[CNT-04] CA2 (2.7): 50 pessoas curtindo ao mesmo tempo → likeCount = 50', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, author);
    const fans = [];
    for (let index = 0; index < 50; index++) {
      fans.push(await createUser(t.database.db));
    }
    const sessions = await Promise.all(fans.map((fan) => directSession(t.app, fan)));
    // 50 requisições simultâneas no mesmo servidor de teste (cada uma registra listeners).
    (t.app.getHttpServer() as { setMaxListeners: (n: number) => void }).setMaxListeners(100);
    const responses = await Promise.all(
      sessions.map((headers) => t.http.put(`/v1/posts/${post.id}/like`).set(headers)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await postRow(post.id)).likeCount).toBe(50);
    expect(await t.database.db.select().from(likes)).toHaveLength(50);
  });

  it('[CNT-04] a mesma pessoa curtindo 5 vezes ao mesmo tempo → 1', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, author);
    const { headers } = await signedInUser(t.http, t.database.db);
    await Promise.all(
      Array.from({ length: 5 }, () => t.http.put(`/v1/posts/${post.id}/like`).set(headers)),
    );
    expect((await postRow(post.id)).likeCount).toBe(1);
  });

  it('[PERM-14] CA3 (2.7): post de pessoa não conectada → 404 idêntico ao de inexistente', async () => {
    const author = await createUser(t.database.db);
    const post = await createPost(t.database.db, author);
    const { headers } = await signedInUser(t.http, t.database.db);
    const denied = await t.http.put(`/v1/posts/${post.id}/like`).set(headers).expect(404);
    const missing = await t.http
      .put('/v1/posts/01a189e0-af57-7000-85fe-2054e618fea6/like')
      .set(headers)
      .expect(404);
    expect(denied.body).toEqual(NOT_FOUND_POST);
    expect(missing.body).toEqual(denied.body);
    await t.http.delete(`/v1/posts/${post.id}/like`).set(headers).expect(404);
    expect(await t.database.db.select().from(likes)).toHaveLength(0);
  });

  it('[PERM-15] nenhuma rota lista quem curtiu: só likeCount e likedByMe', () => {
    const likeRoutes = listRoutes(t.app)
      .filter((route) => route.path.includes('like'))
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(likeRoutes).toEqual(['DELETE /v1/posts/:id/like', 'PUT /v1/posts/:id/like']);
    expect(Object.keys(LikeStateSchema.shape).sort()).toEqual(['likeCount', 'likedByMe']);
  });

  it('[A-06] CA6 (2.7): criador não curte, nem o próprio post → 403', async () => {
    const creator = await verifiedUser(t, { accountType: 'creator' });
    const other = await createUser(t.database.db, { accountType: 'creator' });
    const own = await createTextPostViaApi(t, creator.headers);
    const foreign = await createPost(t.database.db, other);
    for (const id of [own.id, foreign.id, '01a189e0-af57-7000-85fe-2054e618fea6']) {
      const response = await t.http.put(`/v1/posts/${id}/like`).set(creator.headers).expect(403);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
      await t.http.delete(`/v1/posts/${id}/like`).set(creator.headers).expect(403);
    }
  });
});

describe('comentar e responder (2.8)', () => {
  it('[TXT-04] CA1 (2.8): 1 a 500 caracteres; vazio ou 501 → 400; commentCount sobe', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, author);
    const { headers } = await verifiedUser(t, { handle: 'helena' });
    for (const body of ['', '   ', '​', 'a'.repeat(501)]) {
      await t.http.post(`/v1/posts/${post.id}/comments`).set(headers).send({ body }).expect(400);
    }
    const created = await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(headers)
      .send({ body: '😀'.repeat(500) })
      .expect(201);
    expect(CommentSchema.parse(created.body)).toMatchObject({
      parentId: null,
      body: '😀'.repeat(500),
      canDelete: true,
      author: { handle: 'helena', accountType: 'personal', profileVisible: true },
    });
    expect((await postRow(post.id)).commentCount).toBe(1);
    // Espaços nas pontas contam no limite (como no contador do app) e saem ao gravar.
    const trimmed = await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(headers)
      .send({ body: '  bom dia  ' })
      .expect(201);
    expect(CommentSchema.parse(trimmed.body).body).toBe('bom dia');
  });

  it('CA2 (2.8): resposta fica sob o comentário; resposta de resposta → 400', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, author);
    const { headers } = await verifiedUser(t);
    const parent = CommentSchema.parse(
      (
        await t.http
          .post(`/v1/posts/${post.id}/comments`)
          .set(headers)
          .send({ body: 'primeiro' })
          .expect(201)
      ).body,
    );
    const reply = CommentSchema.parse(
      (
        await t.http
          .post(`/v1/posts/${post.id}/comments`)
          .set(headers)
          .send({ body: 'resposta', parentId: parent.id })
          .expect(201)
      ).body,
    );
    expect(reply.parentId).toBe(parent.id);
    const nested = await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(headers)
      .send({ body: 'resposta da resposta', parentId: reply.id })
      .expect(400);
    expect(ErrorResponseSchema.parse(nested.body)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: 'parentId' }],
    });

    const page = await listComments(headers, post.id);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: parent.id, replies: [{ id: reply.id }] });
    expect((await postRow(post.id)).commentCount).toBe(2);
  });

  it('pai de outro post ou inexistente → 404', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, author);
    const other = await createPost(t.database.db, author);
    const foreignComment = await addComment(t.database.db, other, author);
    const { headers } = await verifiedUser(t);
    for (const parentId of [foreignComment.id, '01a189e0-af57-7000-85fe-2054e618fea6']) {
      await t.http
        .post(`/v1/posts/${post.id}/comments`)
        .set(headers)
        .send({ body: 'oi', parentId })
        .expect(404);
    }
  });

  it('lista paginada por comentário de primeiro nível, em ordem cronológica; cursor de outro post → 400', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const post = await createPost(t.database.db, author);
    const other = await createPost(t.database.db, author);
    const reader = await createUser(t.database.db);
    const base = t.clock.now().getTime();
    const roots = [];
    for (let index = 0; index < 5; index++) {
      roots.push(
        await addComment(t.database.db, post, reader, {
          body: `c${String(index)}`,
          createdAt: new Date(base + index * 1000),
        }),
      );
    }
    await addComment(t.database.db, post, author, {
      parentId: roots[0]!.id,
      createdAt: new Date(base + 10_000),
    });
    const { headers } = await signedInUser(t.http, t.database.db);
    const first = await listComments(headers, post.id, '?limit=2');
    expect(first.items.map((item) => item.body)).toEqual(['c0', 'c1']);
    expect(first.items[0]?.replies).toHaveLength(1);
    const second = await listComments(
      headers,
      post.id,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    const third = await listComments(
      headers,
      post.id,
      `?limit=2&cursor=${encodeURIComponent(second.nextCursor ?? '')}`,
    );
    expect([...second.items, ...third.items].map((item) => item.body)).toEqual(['c2', 'c3', 'c4']);
    expect(third.nextCursor).toBeNull();
    await t.http
      .get(`/v1/posts/${other.id}/comments?cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
      .set(headers)
      .expect(400);
  });

  it('[PERM-14] CA3 (2.8): post não visível → listar e comentar dão 404 idêntico ao de inexistente', async () => {
    const author = await createUser(t.database.db);
    const post = await createPost(t.database.db, author);
    const stranger = await verifiedUser(t);
    const creator = await verifiedUser(t, { accountType: 'creator' });
    for (const viewer of [stranger, creator]) {
      const list = await t.http
        .get(`/v1/posts/${post.id}/comments`)
        .set(viewer.headers)
        .expect(404);
      const create = await t.http
        .post(`/v1/posts/${post.id}/comments`)
        .set(viewer.headers)
        .send({ body: 'oi', ...(viewer === creator ? { parentId: post.id } : {}) })
        .expect(404);
      expect(list.body).toEqual(NOT_FOUND_POST);
      expect(create.body).toEqual(NOT_FOUND_POST);
    }
    expect(await t.database.db.select().from(comments)).toHaveLength(0);
  });

  it('[PERM-10c] D11: comentário visível a quem vê o post; o @ só é tocável para conexões', async () => {
    // A conectada a C e a D; C e D não se conhecem. C comenta no post de A.
    const a = await verifiedUser(t, { handle: 'ana.a' });
    const c = await verifiedUser(t, { handle: 'caio.c' });
    const d = await verifiedUser(t, { handle: 'duda.d' });
    await connect(t.database.db, a.user, c.user);
    await connect(t.database.db, a.user, d.user);
    const creator = await verifiedUser(t, { handle: 'cozinha.e', accountType: 'creator' });
    const post = await createTextPostViaApi(t, a.headers);
    await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(c.headers)
      .send({ body: 'Que achado!' })
      .expect(201);
    // Comentário de criador num post de pessoa não existe; num post de criador, o @ é sempre tocável.
    const creatorPost = await createTextPostViaApi(t, creator.headers);
    const creatorComment = await t.http
      .post(`/v1/posts/${creatorPost.id}/comments`)
      .set(c.headers)
      .send({ body: 'oi' })
      .expect(201);
    await t.http
      .post(`/v1/posts/${creatorPost.id}/comments`)
      .set(creator.headers)
      .send({ body: 'obrigada', parentId: CommentSchema.parse(creatorComment.body).id })
      .expect(201);

    const visibility = async (viewer: { headers: Record<string, string> }) =>
      flatten(await listComments(viewer.headers, post.id)).map((item) => [
        item.author.handle,
        item.author.profileVisible,
      ]);
    expect(await visibility(d)).toEqual([['caio.c', false]]);
    expect(await visibility(a)).toEqual([['caio.c', true]]);
    expect(await visibility(c)).toEqual([['caio.c', true]]);
    // Coerente com o perfil: D não abre o perfil de C; A abre.
    await t.http.get('/v1/users/caio.c').set(d.headers).expect(404);
    await t.http.get('/v1/users/caio.c').set(a.headers).expect(200);

    const onCreatorPost = flatten(await listComments(d.headers, creatorPost.id)).map((item) => [
      item.author.handle,
      item.author.profileVisible,
    ]);
    expect(onCreatorPost).toEqual([
      ['caio.c', false],
      ['cozinha.e', true],
    ]);
  });
});

describe('apagar comentário (2.8 CA4)', () => {
  async function scenario() {
    const author = await verifiedUser(t, { accountType: 'creator' });
    const commenter = await verifiedUser(t);
    const bystander = await verifiedUser(t);
    const post = await createTextPostViaApi(t, author.headers);
    const parent = CommentSchema.parse(
      (
        await t.http
          .post(`/v1/posts/${post.id}/comments`)
          .set(commenter.headers)
          .send({ body: 'pai' })
          .expect(201)
      ).body,
    );
    return { author, commenter, bystander, post, parent };
  }

  it('CA4: o autor do comentário apaga; some da lista e o contador cai', async () => {
    const { commenter, bystander, post, parent } = await scenario();
    expect(
      flatten(await listComments(bystander.headers, post.id)).map((item) => item.canDelete),
    ).toEqual([false]);
    await t.http.delete(`/v1/comments/${parent.id}`).set(commenter.headers).expect(204);
    expect((await listComments(bystander.headers, post.id)).items).toEqual([]);
    expect((await postRow(post.id)).commentCount).toBe(0);
    await t.http.delete(`/v1/comments/${parent.id}`).set(commenter.headers).expect(404);
  });

  it('CA4: o autor do post apaga qualquer comentário; apagar o pai apaga as respostas', async () => {
    const { author, commenter, bystander, post, parent } = await scenario();
    await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(bystander.headers)
      .send({ body: 'resposta', parentId: parent.id })
      .expect(201);
    expect((await postRow(post.id)).commentCount).toBe(2);
    expect(
      flatten(await listComments(author.headers, post.id)).every((item) => item.canDelete),
    ).toBe(true);
    await t.http.delete(`/v1/comments/${parent.id}`).set(author.headers).expect(204);
    expect((await listComments(commenter.headers, post.id)).items).toEqual([]);
    expect((await postRow(post.id)).commentCount).toBe(0);
  });

  it('CA4: outra pessoa que vê o post → 403; quem não vê o post → 404 de inexistente', async () => {
    const { bystander, parent } = await scenario();
    const forbidden = await t.http
      .delete(`/v1/comments/${parent.id}`)
      .set(bystander.headers)
      .expect(403);
    expect(ErrorResponseSchema.parse(forbidden.body).code).toBe('FORBIDDEN');

    const personal = await verifiedUser(t);
    const friend = await verifiedUser(t);
    const stranger = await verifiedUser(t);
    await connect(t.database.db, personal.user, friend.user);
    const privatePost = await createTextPostViaApi(t, personal.headers);
    const comment = CommentSchema.parse(
      (
        await t.http
          .post(`/v1/posts/${privatePost.id}/comments`)
          .set(friend.headers)
          .send({ body: 'oi' })
          .expect(201)
      ).body,
    );
    const hidden = await t.http.delete(`/v1/comments/${comment.id}`).set(stranger.headers);
    const missing = await t.http
      .delete('/v1/comments/01a189e0-af57-7000-85fe-2054e618fea6')
      .set(stranger.headers);
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(hidden.body).toEqual(missing.body);
  });
});

describe('criador nos comentários (A-06)', () => {
  it('[A-06] no próprio post: responde (com parentId) e apaga qualquer comentário; primeiro nível → 403', async () => {
    const creator = await verifiedUser(t, { accountType: 'creator' });
    const fan = await verifiedUser(t);
    const post = await createTextPostViaApi(t, creator.headers);
    const topLevel = await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(creator.headers)
      .send({ body: 'oi, pessoal' })
      .expect(403);
    expect(ErrorResponseSchema.parse(topLevel.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');

    const question = CommentSchema.parse(
      (
        await t.http
          .post(`/v1/posts/${post.id}/comments`)
          .set(fan.headers)
          .send({ body: 'Qual a hidratação?' })
          .expect(201)
      ).body,
    );
    const reply = await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(creator.headers)
      .send({ body: '75%!', parentId: question.id })
      .expect(201);
    expect(CommentSchema.parse(reply.body)).toMatchObject({
      parentId: question.id,
      author: { accountType: 'creator', profileVisible: true },
    });
    await t.http.delete(`/v1/comments/${question.id}`).set(creator.headers).expect(204);
    expect((await postRow(post.id)).commentCount).toBe(0);
  });

  it('[A-06] em post de outra conta: comentar ou responder → 403', async () => {
    const creator = await verifiedUser(t, { accountType: 'creator' });
    const otherCreator = await createUser(t.database.db, { accountType: 'creator' });
    const fan = await createUser(t.database.db);
    const post = await createPost(t.database.db, otherCreator);
    const comment = await addComment(t.database.db, post, fan);
    for (const body of [{ body: 'oi' }, { body: 'oi', parentId: comment.id }]) {
      const response = await t.http
        .post(`/v1/posts/${post.id}/comments`)
        .set(creator.headers)
        .send(body)
        .expect(403);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
    }
    // Ler continua liberado.
    await t.http.get(`/v1/posts/${post.id}/comments`).set(creator.headers).expect(200);
  });
});

describe('exclusão de conta: curtidas e comentários (A-13, CONTA-03)', () => {
  it('[CONTA-03] somem na hora e os contadores dos posts são ajustados no DELETE /me', async () => {
    const author = await createUser(t.database.db, { accountType: 'creator' });
    const first = await createPost(t.database.db, author);
    const second = await createPost(t.database.db, author);
    const leaving = await verifiedUser(t);
    const staying = await createUser(t.database.db);
    await addLike(t.database.db, first, leaving.user);
    await addLike(t.database.db, first, staying);
    await addLike(t.database.db, second, leaving.user);
    const comment = await addComment(t.database.db, first, leaving.user);
    await addComment(t.database.db, first, staying, { parentId: comment.id });
    await addComment(t.database.db, second, staying);
    expect(await postRow(first.id)).toMatchObject({ likeCount: 2, commentCount: 2 });

    await t.http
      .delete('/v1/me')
      .set(leaving.headers)
      .send({ password: 'senha-de-teste-1' })
      .expect(204);

    expect(await postRow(first.id)).toMatchObject({ likeCount: 1, commentCount: 0 });
    expect(await postRow(second.id)).toMatchObject({ likeCount: 0, commentCount: 1 });
    const reader = await signedInUser(t.http, t.database.db);
    expect((await listComments(reader.headers, first.id)).items).toEqual([]);
    expect(
      flatten(await listComments(reader.headers, second.id)).map((item) => item.author.handle),
    ).toEqual([staying.handle]);
    const view = await t.http.get(`/v1/posts/${first.id}`).set(reader.headers).expect(200);
    expect(PostSchema.parse(view.body)).toMatchObject({ likeCount: 1, commentCount: 0 });
  });
});
