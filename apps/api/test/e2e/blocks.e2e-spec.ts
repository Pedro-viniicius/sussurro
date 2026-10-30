// E2E do bloqueio (X.2, D5; testes.md PERM-13, PERM-14, PERM-16; A-05). A regra de visibilidade
// fica toda no AccessPolicyService: perfil, posts, comentários, busca e seguir, nos dois sentidos.
import { and, blocks, comments, connections, eq, follows, posts } from '@sussurro/db';
import { addComment, connect, createPost, createUser, follow } from '@sussurro/db/testing';
import {
  BlocksPageSchema,
  CommentsPageSchema,
  CreatorSearchResultSchema,
  ErrorResponseSchema,
  MeSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FOLLOWERS_CACHE_TTL_MS } from '../../src/modules/users/follower-counts.service.js';
import { directUser } from '../support/auth.js';
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

const NOT_FOUND_PROFILE = { code: 'NOT_FOUND', message: 'Perfil não encontrado' };
const NOT_FOUND_POST = { code: 'NOT_FOUND', message: 'Publicação não encontrada' };
const NOT_FOUND_COMMENT = { code: 'NOT_FOUND', message: 'Comentário não encontrado' };
const MISSING_ID = '01a189e0-af57-7000-85fe-2054e618fea6';

function account(options: Parameters<typeof createUser>[1] = {}) {
  return directUser(t.app, t.database.db, options);
}

function blockVia(headers: Record<string, string>, body: object) {
  return t.http.post('/v1/me/blocks').set(headers).send(body);
}

async function blockList(headers: Record<string, string>) {
  const response = await t.http.get('/v1/me/blocks').set(headers).expect(200);
  return BlocksPageSchema.parse(response.body).items.map((item) => item.handle);
}

async function commentHandles(headers: Record<string, string>, postId: string) {
  const response = await t.http.get(`/v1/posts/${postId}/comments`).set(headers).expect(200);
  return CommentsPageSchema.parse(response.body).items.flatMap((item) => [
    `${item.author.handle}:${item.body}`,
    ...item.replies.map((reply) => `${reply.author.handle}:${reply.body}`),
  ]);
}

async function searchHandles(headers: Record<string, string>, q: string) {
  const response = await t.http.get('/v1/search/creators').query({ q }).set(headers).expect(200);
  return CreatorSearchResultSchema.parse(response.body).items.map((item) => item.handle);
}

async function me(headers: Record<string, string>) {
  return MeSchema.parse((await t.http.get('/v1/me').set(headers).expect(200)).body);
}

async function pairConnected(first: string, second: string) {
  const [a, b] = first < second ? [first, second] : [second, first];
  const rows = await t.database.db
    .select()
    .from(connections)
    .where(and(eq(connections.userAId, a), eq(connections.userBId, b)));
  return rows.length > 0;
}

function withoutDate(headers: Record<string, string>) {
  const { date: _date, ...rest } = headers;
  return rest;
}

describe('X.2 CA1: quem foi bloqueado recebe o 404 de inexistente', () => {
  it('[X.2] [PERM-13] [PERM-14] [PERM-16] perfil, abas, post, comentários, curtir e comentar → 404 idêntico, sem URL assinada; nos dois sentidos', async () => {
    const a = await account({ handle: 'ana' });
    const b = await account({ handle: 'bruno' });
    await connect(t.database.db, a.user, b.user);
    const text = await createPost(t.database.db, a.user);
    const photo = await createPost(t.database.db, a.user, { type: 'photo', mediaCount: 1 });
    // Antes: a conexão vê tudo (controle), inclusive a URL assinada da foto.
    await t.http.get('/v1/users/ana').set(b.headers).expect(200);
    const visiblePhoto = await t.http.get(`/v1/posts/${photo.id}`).set(b.headers).expect(200);
    expect(JSON.stringify(visiblePhoto.body)).toContain('Signature');

    const blocked = await blockVia(a.headers, { handle: 'bruno' });
    expect(blocked.status).toBe(204);
    expect(blocked.text).toBe('');

    // [rota para quem foi bloqueado, a mesma rota para algo que não existe]
    const pairs: [method: 'get' | 'put' | 'post', path: string, missing: string, body?: object][] =
      [
        ['get', '/v1/users/ana', '/v1/users/naoexiste'],
        ['get', '/v1/users/ana/posts?type=text', '/v1/users/naoexiste/posts?type=text'],
        ['get', '/v1/users/ana/posts?type=photo', '/v1/users/naoexiste/posts?type=photo'],
        ['get', `/v1/posts/${text.id}`, `/v1/posts/${MISSING_ID}`],
        ['get', `/v1/posts/${photo.id}`, `/v1/posts/${MISSING_ID}`],
        ['get', `/v1/posts/${text.id}/comments`, `/v1/posts/${MISSING_ID}/comments`],
        ['put', `/v1/posts/${photo.id}/like`, `/v1/posts/${MISSING_ID}/like`],
        [
          'post',
          `/v1/posts/${text.id}/comments`,
          `/v1/posts/${MISSING_ID}/comments`,
          { body: 'oi' },
        ],
      ];
    for (const [method, path, missingPath, body] of pairs) {
      const response = await t.http[method](path)
        .set(b.headers)
        .send(body ?? {});
      const missing = await t.http[method](missingPath)
        .set(b.headers)
        .send(body ?? {});
      expect({ path, status: response.status, body: response.body as unknown }).toEqual({
        path,
        status: 404,
        body: missing.body as unknown,
      });
      expect(JSON.stringify(response.body)).not.toContain('Signature');
    }
    expect((await t.http.get('/v1/users/ana').set(b.headers)).body).toEqual(NOT_FOUND_PROFILE);
    expect((await t.http.get(`/v1/posts/${text.id}`).set(b.headers)).body).toEqual(NOT_FOUND_POST);
    // Quem bloqueou também deixa de ver quem foi bloqueado.
    expect((await t.http.get('/v1/users/bruno').set(a.headers)).body).toEqual(NOT_FOUND_PROFILE);
  });

  it('[X.2] criador que bloqueou some da busca e do perfil de quem foi bloqueado (e vice-versa)', async () => {
    const creator = await account({ handle: 'trilhasdosul', accountType: 'creator' });
    await createUser(t.database.db, { handle: 'trilhasnorte', accountType: 'creator' });
    const person = await account({ handle: 'estudante' });
    const other = await account();
    expect(await searchHandles(person.headers, 'trilhas')).toEqual([
      'trilhasdosul',
      'trilhasnorte',
    ]);

    // O criador não vê o perfil da pessoa: bloqueia pelo comentário dela no post dele (D11).
    const post = await createPost(t.database.db, creator.user);
    const comment = await addComment(t.database.db, post, person.user);
    expect((await blockVia(creator.headers, { commentId: comment.id })).status).toBe(204);

    expect(await searchHandles(person.headers, 'trilhas')).toEqual(['trilhasnorte']);
    expect((await t.http.get('/v1/users/trilhasdosul').set(person.headers)).body).toEqual(
      NOT_FOUND_PROFILE,
    );
    expect(await searchHandles(other.headers, 'trilhas')).toEqual(['trilhasdosul', 'trilhasnorte']);

    // E quando é a pessoa quem bloqueia o criador: também some para ela.
    const second = await account();
    expect((await blockVia(second.headers, { handle: 'trilhasnorte' })).status).toBe(204);
    expect(await searchHandles(second.headers, 'trilhas')).toEqual(['trilhasdosul']);
  });

  it('[X.2] comentários: os dois deixam de ver os comentários um do outro em qualquer post; responder ou apagar um escondido → 404', async () => {
    const a = await account({ handle: 'ana' });
    const b = await account({ handle: 'bruno' });
    const c = await account({ handle: 'clara' });
    const creator = await createUser(t.database.db, {
      handle: 'cozinhadabia',
      accountType: 'creator',
    });
    const post = await createPost(t.database.db, creator);
    const minute = (n: number) => ({ createdAt: new Date(t.clock.now().getTime() + n * 60_000) });
    const fromA = await addComment(t.database.db, post, a.user, { body: 'da ana', ...minute(1) });
    const fromB = await addComment(t.database.db, post, b.user, { body: 'do bruno', ...minute(2) });
    await addComment(t.database.db, post, c.user, {
      body: 'resposta da clara',
      parentId: fromB.id,
      ...minute(3),
    });
    await addComment(t.database.db, post, b.user, {
      body: 'resposta do bruno',
      parentId: fromA.id,
      ...minute(4),
    });
    const all = [
      'ana:da ana',
      'bruno:resposta do bruno',
      'bruno:do bruno',
      'clara:resposta da clara',
    ];
    expect(await commentHandles(c.headers, post.id)).toEqual(all);

    // A bloqueia B a partir do comentário (A vê o @ dele pelo D11, sem ver o perfil).
    expect((await blockVia(a.headers, { commentId: fromB.id })).status).toBe(204);
    expect(await blockList(a.headers)).toEqual(['bruno']);

    // A não vê os comentários de B (nem as respostas ao comentário de B); B não vê os de A.
    expect(await commentHandles(a.headers, post.id)).toEqual(['ana:da ana']);
    expect(await commentHandles(b.headers, post.id)).toEqual([
      'bruno:do bruno',
      'clara:resposta da clara',
    ]);
    // Terceiros continuam vendo tudo (o post é de outra conta).
    expect(await commentHandles(c.headers, post.id)).toEqual(all);

    const reply = await t.http
      .post(`/v1/posts/${post.id}/comments`)
      .set(b.headers)
      .send({ body: 'oi', parentId: fromA.id })
      .expect(404);
    expect(reply.body).toEqual(NOT_FOUND_COMMENT);
    const removal = await t.http.delete(`/v1/comments/${fromA.id}`).set(b.headers).expect(404);
    expect(removal.body).toEqual(NOT_FOUND_COMMENT);
  });
});

describe('X.2 CA2: quem foi bloqueado não segue nem se conecta', () => {
  it('[X.2] seguir ou deixar de seguir o criador que bloqueou → o 404 de @ inexistente', async () => {
    const creator = await account({ handle: 'cozinhadabia', accountType: 'creator' });
    const fan = await account({ handle: 'fa_da_bia' });
    const post = await createPost(t.database.db, creator.user);
    const comment = await addComment(t.database.db, post, fan.user);
    expect((await blockVia(creator.headers, { commentId: comment.id })).status).toBe(204);

    for (const method of ['put', 'delete'] as const) {
      const response = await t.http[method]('/v1/creators/cozinhadabia/follow')
        .set(fan.headers)
        .expect(404);
      const missing = await t.http[method]('/v1/creators/naoexiste/follow').set(fan.headers);
      expect(response.body).toEqual(missing.body);
    }
    expect(await t.database.db.select().from(follows)).toHaveLength(0);
    // O pedido de conexão (Fase 4) usa AccessPolicyService.canRequestConnection, que recusa o
    // bloqueio nos dois sentidos (teste unitário da política).
  });
});

describe('X.2 CA3: o bloqueio desfaz conexão e follows e ajusta os contadores', () => {
  it('[X.2] [CNT-03] conexão desfeita (os dois contadores na hora); follow desfeito ("criadores" na hora, seguidores em até 60 s)', async () => {
    const a = await account({ handle: 'ana' });
    const b = await account({ handle: 'bruno' });
    await connect(t.database.db, a.user, b.user);
    expect((await me(a.headers)).counts).toMatchObject({ connections: 1 });
    expect((await me(b.headers)).counts).toMatchObject({ connections: 1 });
    expect((await blockVia(b.headers, { handle: 'ana' })).status).toBe(204);
    expect(await pairConnected(a.user.id, b.user.id)).toBe(false);
    expect((await me(a.headers)).counts).toMatchObject({ connections: 0 });
    expect((await me(b.headers)).counts).toMatchObject({ connections: 0 });

    const creator = await account({ handle: 'cozinhadabia', accountType: 'creator' });
    await follow(t.database.db, a.user, creator.user);
    expect((await me(creator.headers)).counts).toMatchObject({ followers: 1 });
    expect((await blockVia(a.headers, { handle: 'cozinhadabia' })).status).toBe(204);
    expect(await t.database.db.select().from(follows)).toHaveLength(0);
    expect((await me(a.headers)).counts).toMatchObject({ creators: 0 });
    t.clock.advance(FOLLOWERS_CACHE_TTL_MS);
    expect((await me(creator.headers)).counts).toMatchObject({ followers: 0 });
  });

  it('[X.2] os comentários de cada um nos posts do outro (e as respostas) somem com o contador ajustado; desbloquear não traz nada de volta', async () => {
    const a = await account({ handle: 'ana' });
    const b = await account({ handle: 'bruno' });
    const c = await account({ handle: 'clara' });
    await connect(t.database.db, a.user, b.user);
    await connect(t.database.db, a.user, c.user);
    await connect(t.database.db, b.user, c.user);
    const postA = await createPost(t.database.db, a.user);
    const postB = await createPost(t.database.db, b.user);
    const bOnA = await addComment(t.database.db, postA, b.user, { body: 'do bruno' });
    await addComment(t.database.db, postA, c.user, {
      body: 'resposta da clara',
      parentId: bOnA.id,
    });
    await addComment(t.database.db, postA, c.user, { body: 'da clara' });
    await addComment(t.database.db, postB, a.user, { body: 'da ana' });

    expect((await blockVia(a.headers, { handle: 'bruno' })).status).toBe(204);

    const commentCount = async (id: string) =>
      (await t.database.db.select().from(posts).where(eq(posts.id, id)))[0]!.commentCount;
    expect(await commentCount(postA.id)).toBe(1);
    expect(await commentCount(postB.id)).toBe(0);
    expect(await commentHandles(c.headers, postA.id)).toEqual(['clara:da clara']);
    expect(await commentHandles(c.headers, postB.id)).toEqual([]);

    await t.http.delete('/v1/me/blocks/bruno').set(a.headers).expect(204);
    await t.http.delete('/v1/me/blocks/bruno').set(a.headers).expect(204);
    expect(await blockList(a.headers)).toEqual([]);
    // A visibilidade volta, mas a conexão e os comentários não: Bruno é pessoal e não é mais
    // conexão de Ana, então o perfil dele segue fechado para ela.
    expect(await pairConnected(a.user.id, b.user.id)).toBe(false);
    expect(await pairConnected(a.user.id, c.user.id)).toBe(true);
    await t.http.get('/v1/users/bruno').set(a.headers).expect(404);
    const live = (await t.database.db.select().from(comments)).filter(
      (row) => row.deletedAt === null,
    );
    expect(live).toHaveLength(1);
  });
});

describe('X.2: bloquear não é oráculo de existência de @ pessoal', () => {
  it('[A-05] @ inexistente, pessoal não visível, conta excluída e @ inválido → o mesmo 204 do sucesso, sem gravar nada', async () => {
    const owner = await account();
    const friend = await createUser(t.database.db, { handle: 'amiga' });
    await connect(t.database.db, owner.user, friend);
    await createUser(t.database.db, { handle: 'desconhecida' });
    await createUser(t.database.db, { handle: 'excluida', deletedAt: new Date() });

    const success = await blockVia(owner.headers, { handle: 'amiga' });
    expect(success.status).toBe(204);
    for (const handle of ['naoexiste', 'desconhecida', 'excluida', 'Inválido!', 'amiga']) {
      const response = await blockVia(owner.headers, { handle });
      expect({ handle, status: response.status, text: response.text }).toEqual({
        handle,
        status: success.status,
        text: success.text,
      });
      expect(withoutDate(response.headers as Record<string, string>)).toEqual(
        withoutDate(success.headers as Record<string, string>),
      );
    }
    // Só a conta que a pessoa já via foi bloqueada; a lista não revela as outras.
    expect(await blockList(owner.headers)).toEqual(['amiga']);
    expect(await t.database.db.select().from(blocks)).toHaveLength(1);
  });

  it('[X.2] pelo comentário: só o autor de um comentário que a pessoa vê; comentário de post invisível → 204 sem efeito', async () => {
    const reader = await account();
    const friend = await createUser(t.database.db);
    const commenter = await createUser(t.database.db, { handle: 'comentarista' });
    const hidden = await createUser(t.database.db);
    await connect(t.database.db, reader.user, friend);
    await connect(t.database.db, friend, commenter);
    const visiblePost = await createPost(t.database.db, friend);
    const invisiblePost = await createPost(t.database.db, hidden);
    const seen = await addComment(t.database.db, visiblePost, commenter);
    const unseen = await addComment(t.database.db, invisiblePost, commenter);

    expect((await blockVia(reader.headers, { commentId: unseen.id })).status).toBe(204);
    expect((await blockVia(reader.headers, { commentId: MISSING_ID })).status).toBe(204);
    expect(await blockList(reader.headers)).toEqual([]);

    expect((await blockVia(reader.headers, { commentId: seen.id })).status).toBe(204);
    expect(await blockList(reader.headers)).toEqual(['comentarista']);
  });

  it('a própria conta → 400; corpo inválido → 400; rate limit de 60 por hora → 429', async () => {
    const owner = await account({ handle: 'eu_mesma' });
    const post = await createPost(t.database.db, owner.user);
    const own = await addComment(t.database.db, post, owner.user);
    for (const body of [{ handle: 'eu_mesma' }, { commentId: own.id }]) {
      const response = await blockVia(owner.headers, body);
      expect(response.status).toBe(400);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
    }
    for (const body of [{}, { handle: 'a', commentId: own.id }, { userId: own.id }]) {
      expect((await blockVia(owner.headers, body)).status).toBe(400);
    }
    // As 2 recusas pela própria conta já contaram (o limite vem antes de procurar o alvo).
    for (let index = 0; index < 58; index++) {
      expect((await blockVia(owner.headers, { handle: 'naoexiste' })).status).toBe(204);
    }
    expect((await blockVia(owner.headers, { handle: 'naoexiste' })).status).toBe(429);
    await t.http.delete('/v1/me/blocks/naoexiste').set(owner.headers).expect(429);
  });
});

describe('X.2 CA4: a lista de bloqueados é só do dono', () => {
  it('[X.2] GET /me/blocks mostra só os bloqueios de quem chama (só @ e data); ninguém vê quem o bloqueou', async () => {
    const a = await account({ handle: 'ana' });
    const b = await account({ handle: 'bruno' });
    await connect(t.database.db, a.user, b.user);
    expect((await blockVia(a.headers, { handle: 'bruno' })).status).toBe(204);
    const list = BlocksPageSchema.parse(
      (await t.http.get('/v1/me/blocks').set(a.headers).expect(200)).body,
    );
    expect(list).toEqual({
      items: [{ handle: 'bruno', blockedAt: t.clock.now().toISOString() }],
      nextCursor: null,
    });
    expect(await blockList(b.headers)).toEqual([]);
  });
});
