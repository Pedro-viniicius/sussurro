// Teste canário de privacidade (ADR 0004; testes.md PERM-09, PERM-10 e PERM-10b; histórias 3.7 e
// X.2 CA4). O seed cria Y (pessoal) conectado a `canary_conn_*`, seguindo `canary_creator_*`,
// bloqueando `canary_block_*`, bloqueado por `canary_blkby_*` e (Fase 4) com um pedido de conexão
// pendente de `canary_req_in_*` e outro para `canary_req_out_*`. (Fase 6) X3 (criador) tem seguidores
// `canary_follower_*` (NOT-02: nem o próprio criador vê quem o seguiu) e Y tem notificações de
// `canary_conn_*`. O teste enumera todas as rotas
// registradas, preenche os parâmetros pelos mapas de fixtures abaixo e chama cada uma como X1
// (conexão de Y), X2 (pessoal desconhecido), X3 (criador) e anônimo: nenhum corpo, header ou
// mensagem de erro pode conter os canários, fora da allowlist revisada.
//
// Rota nova sem fixture faz o teste falhar: quem cria a rota decide aqui como ela é chamada.
// (ADR 0012) O relato do encosto (`POST /proximity/touches`) entra no PERM-10b, com o encosto
// mútuo de Y com X1 e X2 preparado no setup.
import { randomBytes } from 'node:crypto';

import { blocks, connectionRequests, eq, reports, type UserRow } from '@sussurro/db';
import {
  addComment,
  block,
  connect,
  createPost,
  createUser,
  follow,
  TEST_PASSWORD,
} from '@sussurro/db/testing';
import { AuthSessionSchema, ProximityTokenSchema } from '@sussurro/shared';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { directSession } from '../support/auth.js';
import { listRoutes, type RegisteredRoute, routeKey } from '../support/routes.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;

const suffix = randomBytes(3).toString('hex');
const CANARY = {
  conn: `canary_conn_${suffix}`,
  creator: `canary_creator_${suffix}`,
  block: `canary_block_${suffix}`,
  blockedBy: `canary_blkby_${suffix}`,
  requestIn: `canary_req_in_${suffix}`,
  requestOut: `canary_req_out_${suffix}`,
  follower: `canary_follower_${suffix}`,
};
/** Prefixos que nunca podem sair para X1, X2, X3 e anônimo. */
const FORBIDDEN = [
  'canary_conn_',
  'canary_creator_',
  'canary_block_',
  'canary_blkby_',
  'canary_req_',
  // Fase 6 (NOT-02): quem seguiu um criador não aparece para ninguém, nem para o criador.
  'canary_follower_',
];

interface Fixture {
  y: UserRow;
  x1: UserRow;
  x2: UserRow;
  x3: UserRow;
  canaryConn: UserRow;
  canaryCreator: UserRow;
  textPostId: string;
  photoPostId: string;
  /** Fase 5: reel publicado de Y, reel de Y ainda processando e rascunho de reel de Y. */
  reelPostId: string;
  processingReelId: string;
  reelDraftId: string;
  yCommentId: string;
  /** Pedido de conexão pendente canary_req_in → Y. */
  incomingRequestId: string;
  /** Pedido de conexão pendente Y → canary_req_out. */
  outgoingRequestId: string;
  /**
   * Token de proximidade de Y do QR (`qrToken`; a tela Conectar de Y está aberta durante o teste).
   */
  yToken: string;
  /**
   * (ADR 0012) `bleToken` de Y, o do anúncio. Y já relatou o encosto com X1 e X2: quando eles
   * relatam este token no `touches`, o encosto é mútuo e eles recebem o cartão de Y.
   */
  yBleToken: string;
  /** (ADR 0012) `bleToken` de X1 e de X2, na ordem, que Y relata no encosto. */
  callerBleTokens: string[];
  /** Fase 6: os seguidores canários de X3 (ids, para o NOT-02 no push). */
  followerIds: string[];
}

let fx: Fixture;
interface Caller {
  name: string;
  headers: Record<string, string>;
  /** Credenciais para o login e o refresh do PERM-10b (o anônimo não tem). */
  email?: string;
}
let callers: Caller[];
let yHeaders: Record<string, string>;

/** Um caminho concreto a chamar, com os prefixos de canário permitidos nele (allowlist). */
interface Call {
  path: string;
  allow?: string[];
}

/**
 * [PERM-10] Fixtures de TODAS as rotas GET. Os parâmetros apontam para Y (o perfil, os posts e os
 * comentários dele). Allowlist (testes.md PERM-10): rotas cujo alvo explícito é o próprio criador
 * canário (o perfil dele e a busca por "canary"), que é público por definição.
 */
function getFixtures(): Record<string, Call[]> {
  const y = fx.y.handle;
  return {
    'GET /health': [{ path: '/health' }],
    'GET /health/ready': [{ path: '/health/ready' }],
    'GET /v1/me': [{ path: '/v1/me' }],
    'GET /v1/users/:handle': [
      { path: `/v1/users/${y}` },
      { path: `/v1/users/${CANARY.conn}` },
      { path: `/v1/users/${CANARY.block}` },
      { path: `/v1/users/${CANARY.creator}`, allow: ['canary_creator_'] },
      // Fase 6 (NOT-02): o perfil do criador que tem seguidores canários.
      { path: `/v1/users/${fx.x3.handle}` },
    ],
    'GET /v1/users/:handle/posts': [
      { path: `/v1/users/${y}/posts?type=text` },
      { path: `/v1/users/${y}/posts?type=photo` },
      // Fase 5: a aba Reels (com o reel processando de Y, que só o próprio Y vê).
      { path: `/v1/users/${y}/posts?type=reel` },
    ],
    'GET /v1/posts/:id': [
      { path: `/v1/posts/${fx.textPostId}` },
      { path: `/v1/posts/${fx.photoPostId}` },
      { path: `/v1/posts/${fx.reelPostId}` },
      { path: `/v1/posts/${fx.processingReelId}` },
      { path: `/v1/posts/${fx.reelDraftId}` },
    ],
    'GET /v1/posts/:id/comments': [
      { path: `/v1/posts/${fx.textPostId}/comments` },
      { path: `/v1/posts/${fx.reelPostId}/comments` },
    ],
    'GET /v1/feed': [
      { path: '/v1/feed?type=text' },
      { path: '/v1/feed?type=photo' },
      { path: '/v1/feed?type=reel' },
    ],
    'GET /v1/search/creators': [
      { path: '/v1/search/creators?q=canary', allow: ['canary_creator_'] },
      { path: `/v1/search/creators?q=${y.slice(0, 5)}` },
    ],
    'GET /v1/me/connections': [{ path: '/v1/me/connections' }],
    'GET /v1/me/following': [{ path: '/v1/me/following' }],
    'GET /v1/me/blocks': [{ path: '/v1/me/blocks' }],
    // Fase 4: só os pedidos de quem chama; o pedido de Y para os outros é o 404 de inexistente.
    'GET /v1/connections/requests/incoming': [{ path: '/v1/connections/requests/incoming' }],
    'GET /v1/connections/requests/:id': [
      { path: `/v1/connections/requests/${fx.incomingRequestId}` },
      { path: `/v1/connections/requests/${fx.outgoingRequestId}` },
    ],
    // Fase 6: só as notificações de quem chama. Para X3, a de seguidores (só o número, NOT-02).
    'GET /v1/notifications': [{ path: '/v1/notifications' }],
    'GET /v1/notifications/unread-count': [{ path: '/v1/notifications/unread-count' }],
  };
}

/** Uma chamada de rota que não é GET (PERM-10b). */
interface Mutation {
  method: 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: (caller: Caller) => unknown;
  allow?: string[];
}

/**
 * [PERM-10b] Toda rota que não é GET: chamada (quando devolve dados) ou dispensada com o motivo.
 * Rota nova sem classificação faz o teste falhar.
 */
function mutationFixtures(): Record<string, Mutation[] | { skip: string }> {
  const post = fx.textPostId;
  return {
    'POST /v1/auth/register': [
      {
        method: 'post',
        path: '/v1/auth/register',
        body: () => ({
          email: `novo_${randomBytes(3).toString('hex')}@example.com`,
          password: 'cafe-coado-42',
          handle: `novo_${randomBytes(3).toString('hex')}`,
          name: 'Conta nova',
        }),
      },
    ],
    'POST /v1/auth/login': [
      {
        method: 'post',
        path: '/v1/auth/login',
        body: (caller) => ({
          email: caller.email ?? 'ninguem@example.com',
          password: TEST_PASSWORD,
        }),
      },
    ],
    'POST /v1/auth/refresh': [{ method: 'post', path: '/v1/auth/refresh' }],
    'POST /v1/auth/logout': { skip: '204 sem corpo; revogaria a sessão usada no resto do teste' },
    'POST /v1/auth/logout-all': { skip: '204 sem corpo; revogaria as sessões do teste' },
    'POST /v1/auth/password/forgot': { skip: '202 igual para qualquer e-mail, sem corpo' },
    'POST /v1/auth/password/reset': { skip: 'só recebe um token; responde 204 ou 400 sem dados' },
    'POST /v1/auth/email/verify': { skip: 'só recebe um token; responde 204 ou 400 sem dados' },
    'PATCH /v1/me': [{ method: 'patch', path: '/v1/me', body: () => ({ bio: 'Bio do canário.' }) }],
    'DELETE /v1/me': { skip: '204 sem corpo; excluiria a conta de quem chama' },
    'POST /v1/me/email/verification': { skip: '202 sem corpo' },
    'POST /v1/me/avatar/upload-url': [
      {
        method: 'post',
        path: '/v1/me/avatar/upload-url',
        body: () => ({ mime: 'image/jpeg', sizeBytes: 1024 }),
      },
    ],
    'PUT /v1/me/avatar': [
      { method: 'put', path: '/v1/me/avatar', body: () => ({ uploadId: fx.yCommentId }) },
    ],
    'DELETE /v1/me/avatar': { skip: '204 sem corpo; só mexe na foto de quem chama' },
    'POST /v1/posts': [
      { method: 'post', path: '/v1/posts', body: () => ({ type: 'text', text: 'Post do teste.' }) },
    ],
    'POST /v1/posts/drafts': [
      {
        method: 'post',
        path: '/v1/posts/drafts',
        body: () => ({ type: 'photo', items: [{ mime: 'image/jpeg', sizeBytes: 1024 }] }),
      },
      // Fase 5: rascunho de reel (vídeo + poster).
      {
        method: 'post',
        path: '/v1/posts/drafts',
        body: () => ({
          type: 'reel',
          video: { mime: 'video/mp4', sizeBytes: 4096, durationS: 30 },
          poster: { mime: 'image/jpeg', sizeBytes: 512 },
        }),
      },
    ],
    'POST /v1/posts/:id/publish': [
      { method: 'post', path: `/v1/posts/${post}/publish`, body: () => ({}) },
      // O rascunho de reel de Y e o reel de Y processando: os outros recebem o 404 de inexistente.
      { method: 'post', path: `/v1/posts/${fx.reelDraftId}/publish`, body: () => ({}) },
      { method: 'post', path: `/v1/posts/${fx.processingReelId}/publish`, body: () => ({}) },
    ],
    'DELETE /v1/posts/:id': [{ method: 'delete', path: `/v1/posts/${post}` }],
    'PUT /v1/posts/:id/like': [{ method: 'put', path: `/v1/posts/${post}/like` }],
    'DELETE /v1/posts/:id/like': [{ method: 'delete', path: `/v1/posts/${post}/like` }],
    'POST /v1/posts/:id/comments': [
      { method: 'post', path: `/v1/posts/${post}/comments`, body: () => ({ body: 'Oi, Y.' }) },
    ],
    'DELETE /v1/comments/:id': [{ method: 'delete', path: `/v1/comments/${fx.yCommentId}` }],
    'PUT /v1/creators/:handle/follow': [
      { method: 'put', path: `/v1/creators/${CANARY.creator}/follow`, allow: ['canary_creator_'] },
    ],
    'DELETE /v1/creators/:handle/follow': [
      {
        method: 'delete',
        path: `/v1/creators/${CANARY.creator}/follow`,
        allow: ['canary_creator_'],
      },
    ],
    'POST /v1/me/blocks': [
      { method: 'post', path: '/v1/me/blocks', body: () => ({ handle: CANARY.conn }) },
      { method: 'post', path: '/v1/me/blocks', body: () => ({ commentId: fx.yCommentId }) },
    ],
    'DELETE /v1/me/blocks/:handle': [{ method: 'delete', path: `/v1/me/blocks/${CANARY.block}` }],
    // Fase 4. resolve e pedido com o token de Y: devolvem só Y (o alvo explícito) e a relação de
    // quem chama com Y, nunca as relações de Y. Os pedidos de Y e a conexão de Y com canary_conn
    // dão o 404 de inexistente para os outros.
    'POST /v1/proximity/tokens': [{ method: 'post', path: '/v1/proximity/tokens' }],
    // ADR 0012: o relato do encosto (A2-1: exatamente 1 token). O controle positivo, antes desta
    // varredura, já casou X1 e X2 com Y (o par X2–Y é o que o pedido `ble` abaixo usa); aqui, depois
    // dos bloqueios da própria varredura, a resposta não pode trazer canário nem relação de Y.
    'POST /v1/proximity/touches': [
      {
        method: 'post',
        path: '/v1/proximity/touches',
        body: () => ({ tokens: [fx.yBleToken] }),
      },
    ],
    'POST /v1/proximity/resolve': [
      {
        method: 'post',
        path: '/v1/proximity/resolve',
        body: () => ({ tokens: [fx.yToken, 'AAAAAAAAAAAAAAAA'] }),
      },
    ],
    'POST /v1/connections/requests': [
      {
        method: 'post',
        path: '/v1/connections/requests',
        body: () => ({ targetToken: fx.yBleToken, method: 'ble' }),
      },
      {
        method: 'post',
        path: '/v1/connections/requests',
        body: () => ({ targetToken: fx.yToken, method: 'qr' }),
      },
    ],
    'POST /v1/connections/requests/:id/accept': [
      {
        method: 'post',
        path: `/v1/connections/requests/${fx.incomingRequestId}/accept`,
        body: () => ({ observedToken: fx.yToken }),
      },
    ],
    'POST /v1/connections/requests/:id/decline': [
      { method: 'post', path: `/v1/connections/requests/${fx.incomingRequestId}/decline` },
    ],
    'DELETE /v1/connections/requests/:id': [
      { method: 'delete', path: `/v1/connections/requests/${fx.outgoingRequestId}` },
    ],
    'DELETE /v1/connections/:handle': [
      { method: 'delete', path: `/v1/connections/${CANARY.conn}` },
    ],
    // Fase 6: marcar como lidas devolve só o número; push tokens, 204 sem corpo (só os de quem chama).
    'POST /v1/notifications/read': [
      {
        method: 'post',
        path: '/v1/notifications/read',
        body: () => ({ upTo: '2099-01-01T00:00:00.000Z' }),
      },
    ],
    'PUT /v1/me/push-tokens': [
      {
        method: 'put',
        path: '/v1/me/push-tokens',
        body: () => ({ expoToken: 'ExponentPushToken[canario-aparelho-1]', platform: 'ios' }),
      },
    ],
    'DELETE /v1/me/push-tokens': [
      {
        method: 'delete',
        path: '/v1/me/push-tokens',
        body: () => ({ expoToken: 'ExponentPushToken[canario-aparelho-1]' }),
      },
    ],
    'POST /v1/reports': [
      {
        method: 'post',
        path: '/v1/reports',
        body: () => ({ target: { type: 'account', handle: CANARY.conn }, reason: 'spam' }),
      },
      {
        method: 'post',
        path: '/v1/reports',
        body: () => ({ target: { type: 'post', id: post }, reason: 'spam' }),
      },
    ],
  };
}

/** Tudo o que sai da resposta: status, headers e corpo (inclusive mensagens de erro). */
function leakedPrefixes(response: Response, allow: readonly string[] = []): string[] {
  const visible = `${JSON.stringify(response.headers)}\n${response.text}`;
  return FORBIDDEN.filter((prefix) => !allow.includes(prefix) && visible.includes(prefix));
}

beforeAll(async () => {
  t = await createTestApp();
  const db = t.database.db;
  const verified = { emailVerifiedAt: new Date() };
  const y = await createUser(db, { handle: `y_${suffix}`, ...verified });
  const canaryConn = await createUser(db, { handle: CANARY.conn, ...verified });
  const canaryCreator = await createUser(db, {
    handle: CANARY.creator,
    accountType: 'creator',
    ...verified,
  });
  const canaryBlock = await createUser(db, { handle: CANARY.block, ...verified });
  const canaryBlockedBy = await createUser(db, { handle: CANARY.blockedBy, ...verified });
  const canaryRequestIn = await createUser(db, { handle: CANARY.requestIn, ...verified });
  const canaryRequestOut = await createUser(db, { handle: CANARY.requestOut, ...verified });
  const x1 = await createUser(db, { handle: `x1_${suffix}`, ...verified });
  const x2 = await createUser(db, { handle: `x2_${suffix}`, ...verified });
  const x3 = await createUser(db, { handle: `x3_${suffix}`, accountType: 'creator', ...verified });

  await connect(db, y, canaryConn);
  await connect(db, y, x1);
  await follow(db, y, canaryCreator);
  // Bloqueios no seed (X.2 CA4): Y bloqueou um, e outro bloqueou Y.
  await block(db, y, canaryBlock);
  await block(db, canaryBlockedBy, y);

  const textPost = await createPost(db, y, { text: 'Post de texto do Y.' });
  const photoPost = await createPost(db, y, { type: 'photo', mediaCount: 2 });
  const yComment = await addComment(db, textPost, y, { body: 'Comentário do Y.' });
  await addComment(db, textPost, x1, { body: 'Comentário do X1.', parentId: yComment.id });
  // Fase 5: reels de Y (publicado, processando e rascunho), com a legenda citando a conexão.
  const reelPost = await createPost(db, y, { type: 'reel', caption: 'Reel do Y.' });
  const processingReel = await createPost(db, y, {
    type: 'reel',
    status: 'processing',
    caption: `Com ${CANARY.conn}, ainda processando.`,
  });
  const reelDraft = await createPost(db, y, { type: 'reel', status: 'draft' });
  // Conteúdo dos canários, que Y vê no feed e ninguém mais (X1 não é conexão de canary_conn).
  await createPost(db, canaryConn, { text: 'Post da conexão canária.' });
  await createPost(db, canaryConn, { type: 'reel', caption: 'Reel da conexão canária.' });
  await createPost(db, canaryCreator, { text: 'Post do criador canário.' });

  fx = {
    y,
    x1,
    x2,
    x3,
    canaryConn,
    canaryCreator,
    textPostId: textPost.id,
    photoPostId: photoPost.id,
    reelPostId: reelPost.id,
    processingReelId: processingReel.id,
    reelDraftId: reelDraft.id,
    yCommentId: yComment.id,
    incomingRequestId: await pendingRequestRow(canaryRequestIn, y),
    outgoingRequestId: await pendingRequestRow(y, canaryRequestOut),
    yToken: '',
    yBleToken: '',
    callerBleTokens: [],
    followerIds: [],
  };
  callers = [
    { name: 'X1 (conexão de Y)', headers: await directSession(t.app, x1), email: x1.email },
    { name: 'X2 (pessoal desconhecido)', headers: await directSession(t.app, x2), email: x2.email },
    { name: 'X3 (criador)', headers: await directSession(t.app, x3), email: x3.email },
    { name: 'anônimo', headers: {} },
  ];
  yHeaders = await directSession(t.app, y);
  // A tela Conectar de Y e as de X1 e X2 abertas (o resolve, o touches e o pedido exigem).
  const yTokens = ProximityTokenSchema.parse(
    (await t.http.post('/v1/proximity/tokens').set(yHeaders).expect(201)).body,
  );
  fx.yToken = yTokens.qrToken;
  fx.yBleToken = yTokens.bleToken;
  const callerBleTokens: string[] = [];
  for (const caller of callers.slice(0, 2)) {
    const issued = ProximityTokenSchema.parse(
      (await t.http.post('/v1/proximity/tokens').set(caller.headers).expect(201)).body,
    );
    callerBleTokens.push(issued.bleToken);
  }
  fx.callerBleTokens = callerBleTokens;
  // (ADR 0012) Y relata o encosto com X1 e X2 (ainda sem cartão: eles não relataram Y). A2-1: um
  // token por chamada.
  for (const token of callerBleTokens) {
    const yTouch = await t.http
      .post('/v1/proximity/touches')
      .set(yHeaders)
      .send({ tokens: [token] })
      .expect(200);
    expect(yTouch.body).toEqual({ items: [] });
  }

  // Fase 6. Seguidores canários de X3, pela API (o upsert anônimo de verdade), e notificações de Y
  // vindas de canary_conn (curtida pela API; "conectados" e o push enfileirado).
  for (const index of [1, 2]) {
    const follower = await createUser(db, {
      handle: `${CANARY.follower}_${String(index)}`,
      ...verified,
    });
    fx.followerIds.push(follower.id);
    await t.http
      .put(`/v1/creators/${x3.handle}/follow`)
      .set(await directSession(t.app, follower))
      .expect(200);
  }
  await t.http
    .put(`/v1/posts/${textPost.id}/like`)
    .set(await directSession(t.app, canaryConn))
    .expect(200);
});

afterAll(async () => {
  await t.close();
});

/** Pedido de conexão pendente `from → to`, direto no banco (Fase 4). */
async function pendingRequestRow(from: UserRow, to: UserRow): Promise<string> {
  const now = t.clock.now();
  const [row] = await t.database.db
    .insert(connectionRequests)
    .values({
      fromId: from.id,
      toId: to.id,
      method: 'ble',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 120_000),
    })
    .returning({ id: connectionRequests.id });
  return row!.id;
}

describe('canário de privacidade (PERM-10)', () => {
  it('[PERM-10] toda rota GET registrada tem fixture (rota nova sem fixture falha aqui)', () => {
    const registered = listRoutes(t.app)
      .filter((route) => route.method === 'GET')
      .map(routeKey)
      .sort();
    expect(Object.keys(getFixtures()).sort()).toEqual(registered);
  });

  it('[PERM-10] [X.2] nenhuma rota GET devolve os canários para X1, X2, X3 ou anônimo', async () => {
    const leaks: string[] = [];
    let calls = 0;
    for (const [route, fixtureCalls] of Object.entries(getFixtures())) {
      for (const call of fixtureCalls) {
        for (const caller of callers) {
          const response = await t.http.get(call.path).set(caller.headers);
          calls++;
          expect(response.status, `${route} ${call.path} (${caller.name})`).toBeLessThan(500);
          for (const prefix of leakedPrefixes(response, call.allow)) {
            leaks.push(`${caller.name} → ${call.path}: ${prefix}`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(4 * 18);
  });

  it('[PERM-10] o canário está vivo: Y vê as próprias listas (controle positivo), mas nunca quem o bloqueou', async () => {
    const seen = new Set<string>();
    for (const fixtureCalls of Object.values(getFixtures())) {
      for (const call of fixtureCalls) {
        const response = await t.http.get(call.path).set(yHeaders);
        expect(response.status, call.path).toBeLessThan(500);
        for (const prefix of FORBIDDEN) {
          if (`${JSON.stringify(response.headers)}${response.text}`.includes(prefix)) {
            seen.add(prefix);
          }
        }
      }
    }
    // Conexão, criador seguido e bloqueado aparecem nas listas de Y (/me/*) e no feed dele.
    expect([...seen].sort()).toEqual([
      'canary_block_',
      'canary_conn_',
      'canary_creator_',
      'canary_req_',
    ]);
  });
});

describe('canário de seguidores (NOT-02, 6.3 CA2)', () => {
  it('[NOT-02] o criador vê só o número; nem as respostas nem o push trazem id, @ ou nome de quem seguiu', async () => {
    const x3 = callers[2]!;
    const response = await t.http.get('/v1/notifications').set(x3.headers).expect(200);
    // Controle positivo: a notificação existe (2 seguidores no dia).
    expect(response.body).toMatchObject({ items: [{ type: 'new_followers', count: 2 }] });
    const everything = [
      response.text,
      (await t.http.get('/v1/notifications/unread-count').set(x3.headers)).text,
      (await t.http.get(`/v1/users/${fx.x3.handle}`).set(x3.headers)).text,
      (await t.http.get('/v1/me').set(x3.headers)).text,
      JSON.stringify(t.push.sent),
    ].join('\n');
    expect(everything).not.toContain('canary_follower_');
    for (const id of fx.followerIds) {
      expect(everything).not.toContain(id);
    }
  });
});

describe('canário nos POST/PUT/DELETE que devolvem dados (PERM-10b)', () => {
  it('[PERM-10b] toda rota que não é GET está classificada (chamada ou dispensada com o motivo)', () => {
    const registered = listRoutes(t.app)
      .filter((route) => route.method !== 'GET')
      .map(routeKey)
      .sort();
    expect(Object.keys(mutationFixtures()).sort()).toEqual(registered);
  });

  /** As chaves do cartão do `touches` (o do encosto e o devido), em ordem alfabética. */
  const TOUCH_CARD_KEYS = [
    'alreadyConnected',
    'avatarUrl',
    'handle',
    'name',
    'pairExpiresInS',
    'token',
  ];

  // Antes da varredura abaixo: nela, X1 e X2 bloqueiam Y (pelo comentário de Y, `POST /me/blocks`),
  // e daí em diante o touches e o resolve de Y voltam vazios para eles.
  it('[PERM-10b] [PROX-37] [PROX-49] controle positivo: com o encosto mútuo, X1 e X2 recebem o cartão de Y no touches (e no resolve do QR), e Y recebe o de cada um no relato seguinte (cartão devido), sem canário, só com @, nome, foto, alreadyConnected e (no encosto) pairExpiresInS', async () => {
    const touchFromY = (token: string) =>
      t.http
        .post('/v1/proximity/touches')
        .set(yHeaders)
        .send({ tokens: [token] })
        .expect(200);
    for (const [index, caller] of callers.slice(0, 2).entries()) {
      const callerBleToken = fx.callerBleTokens[index]!;
      if (index > 0) {
        // (A2-2) Uma pessoa por vez: Y acabou de receber o cartão de X1 e fica ocupada 10 s; e a
        // observação de X2 que Y gravou no setup já passou da janela (5 s do primeiro relato). Y
        // relata X2 de novo, como o app faria num encosto novo.
        t.clock.advance(10 * 1_000);
        expect((await touchFromY(callerBleToken)).body).toEqual({ items: [] });
      }
      const responses = [
        await t.http
          .post('/v1/proximity/touches')
          .set(caller.headers)
          .send({ tokens: [fx.yBleToken] })
          .expect(200),
        await t.http
          .post('/v1/proximity/resolve')
          .set(caller.headers)
          .send({ tokens: [fx.yToken] })
          .expect(200),
      ];
      for (const [kind, response] of responses.entries()) {
        const items = (response.body as { items: Record<string, unknown>[] }).items;
        expect(items, `${caller.name} ${String(kind)}`).toHaveLength(1);
        // O cartão do encosto traz também o prazo do par (A2 rev. 1, R1-10); o do QR, não.
        expect(Object.keys(items[0]!).sort()).toEqual(
          kind === 0
            ? TOUCH_CARD_KEYS
            : ['alreadyConnected', 'avatarUrl', 'handle', 'name', 'token'],
        );
        expect(items[0]).toMatchObject({
          token: kind === 0 ? fx.yBleToken : fx.yToken,
          handle: fx.y.handle,
          name: fx.y.name,
          // X1 é conexão de Y; X2, não.
          alreadyConnected: index === 0,
          ...(kind === 0 ? { pairExpiresInS: 55 } : {}),
        });
        expect(leakedPrefixes(response)).toEqual([]);
      }

      // Revelação simétrica (A2-2): no relato seguinte, Y recebe o cartão de quem casou com ela,
      // com o token que relatou, e nada das relações dele.
      const delivered = await touchFromY(callerBleToken);
      const owed = (delivered.body as { items: Record<string, unknown>[] }).items;
      expect(owed, `${caller.name} → Y`).toHaveLength(1);
      expect(Object.keys(owed[0]!).sort()).toEqual(TOUCH_CARD_KEYS);
      const callerUser = index === 0 ? fx.x1 : fx.x2;
      expect(owed[0]).toMatchObject({
        token: callerBleToken,
        handle: callerUser.handle,
        name: callerUser.name,
        alreadyConnected: index === 0,
        pairExpiresInS: 55,
      });
      expect(leakedPrefixes(delivered)).toEqual([]);
    }
  });

  it('[PERM-10b] login, refresh, seguir, bloquear, denunciar e as demais não vazam os canários', async () => {
    const leaks: string[] = [];
    // Refresh tokens reais (login pela API) para o /auth/refresh.
    const refreshOf = new Map<string, string>();
    for (const caller of callers.filter((item) => item.email !== undefined)) {
      const response = await t.http
        .post('/v1/auth/login')
        .send({ email: caller.email, password: TEST_PASSWORD })
        .expect(200);
      refreshOf.set(caller.name, AuthSessionSchema.parse(response.body).tokens.refreshToken);
      for (const prefix of leakedPrefixes(response)) {
        leaks.push(`${caller.name} → login: ${prefix}`);
      }
    }
    for (const [route, fixture] of Object.entries(mutationFixtures())) {
      if (!Array.isArray(fixture)) {
        continue;
      }
      for (const mutation of fixture) {
        for (const caller of callers) {
          const body =
            route === 'POST /v1/auth/refresh'
              ? { refreshToken: refreshOf.get(caller.name) ?? 'invalido' }
              : (mutation.body?.(caller) ?? {});
          const response = await t.http[mutation.method](mutation.path)
            .set(caller.headers)
            .send(body);
          expect(response.status, `${route} (${caller.name})`).toBeLessThan(500);
          for (const prefix of leakedPrefixes(response, mutation.allow)) {
            leaks.push(`${caller.name} → ${route}: ${prefix}`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);

    // (A2 rev. 1, R1-5) Bloquear e denunciar pelo @ passaram a aceitar também quem tem par
    // encostado vivo com quem chama. Os pares aqui são X1–Y e X2–Y (o controle positivo); ninguém da
    // varredura tem par com canary_conn, que ninguém vê: o @ dela continua sem gravar nada.
    expect(await t.proximity.hasTouchPair(fx.x1.id, fx.canaryConn.id)).toBe(false);
    expect(await t.proximity.hasTouchPair(fx.x2.id, fx.canaryConn.id)).toBe(false);
    expect(
      await t.database.db.select().from(blocks).where(eq(blocks.blockedId, fx.canaryConn.id)),
    ).toEqual([]);
    expect(
      await t.database.db.select().from(reports).where(eq(reports.targetUserId, fx.canaryConn.id)),
    ).toEqual([]);
  });
});

/** A forma de um schema Zod contém uma lista de objetos com `handle` (uma lista de contas)? */
function listsAccounts(schema: z.ZodType | undefined): boolean {
  if (schema === undefined) {
    return false;
  }
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const inner = (key: string) => def[key] as z.ZodType | undefined;
  switch (def.type) {
    case 'array': {
      const element = inner('element');
      return hasHandle(element) || listsAccounts(element);
    }
    case 'object':
      return Object.values(def.shape as Record<string, z.ZodType>).some(listsAccounts);
    case 'union':
      return (def.options as z.ZodType[]).some(listsAccounts);
    case 'nullable':
    case 'optional':
    case 'default':
      return listsAccounts(inner('innerType'));
    case 'pipe':
      return listsAccounts(inner('out'));
    default:
      return false;
  }
}

/** O objeto (ou algum objeto aninhado nele) tem a chave `handle`. */
function hasHandle(schema: z.ZodType | undefined): boolean {
  if (schema === undefined) {
    return false;
  }
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  if (def.type === 'object') {
    const shape = def.shape as Record<string, z.ZodType>;
    return 'handle' in shape || Object.values(shape).some(hasHandle);
  }
  if (def.type === 'union') {
    return (def.options as z.ZodType[]).some(hasHandle);
  }
  return false;
}

describe('inventário de rotas (PERM-09)', () => {
  /**
   * Rotas com `:id`/`:handle` que devolvem listas com contas, revisadas: as publicações da própria
   * conta do @ (o autor é sempre ela) e os comentários de um post (D11, visíveis a quem vê o post).
   * (Fase 4) As rotas de pedido de conexão não entram aqui: `GET .../requests/:id` devolve um
   * pedido só (a outra pessoa dele) e `incoming` não recebe id nem @ de outra conta.
   */
  const ALLOWLIST = ['GET /v1/users/:handle/posts', 'GET /v1/posts/:id/comments'];

  it('[PERM-09] nenhuma rota com :id/:handle devolve lista de contas, fora da allowlist revisada', () => {
    const withParams = listRoutes(t.app).filter((route: RegisteredRoute) =>
      /:\w+/.test(route.path),
    );
    const listing = withParams
      .filter((route) => listsAccounts(route.responseSchema))
      .map(routeKey)
      .sort();
    expect(listing).toEqual([...ALLOWLIST].sort());
    // E as listas de relacionamento só existem em /me/* (sem parâmetro de outra conta).
    const relationLists = listRoutes(t.app)
      .filter((route) => /connections|following|followers|blocks/.test(route.path))
      .filter((route) => route.method === 'GET')
      .map(routeKey)
      .sort();
    expect(relationLists).toEqual([
      // Fase 4: os pedidos de quem chama (um por id, só para as duas pessoas; a caixa de
      // entrada, só os pedidos para quem chama). Nenhuma lista de conexões de outra conta.
      'GET /v1/connections/requests/:id',
      'GET /v1/connections/requests/incoming',
      'GET /v1/me/blocks',
      'GET /v1/me/connections',
      'GET /v1/me/following',
    ]);
  });

  it('[PERM-09] o detector enxerga uma lista de contas (controle)', () => {
    const search = listRoutes(t.app).find((route) => route.path === '/v1/search/creators');
    expect(listsAccounts(search?.responseSchema)).toBe(true);
    const profile = listRoutes(t.app).find((route) => route.path === '/v1/users/:handle');
    expect(listsAccounts(profile?.responseSchema)).toBe(false);
  });
});
