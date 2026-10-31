import type { UserRow } from '@sussurro/db';
import {
  type ConnectionRequest,
  ConnectionRequestSchema,
  type ProximityToken,
  ProximityTokenSchema,
  type ProximityTouchItem,
  ProximityTouchResultSchema,
} from '@sussurro/shared';
import type { Response } from 'supertest';

import { directSession, directUser } from './auth.js';
import type { TestApp } from './test-app.js';

/** Conta pessoal com e-mail confirmado e sessão direta (sem o rate limit de login). */
export interface Person {
  user: UserRow;
  headers: Record<string, string>;
}

export async function person(t: TestApp, handle?: string): Promise<Person> {
  return directUser(t.app, t.database.db, handle === undefined ? {} : { handle });
}

/**
 * `POST /proximity/tokens`: abre (ou mantém aberta) a tela Conectar e devolve a emissão inteira
 * (ADR 0012 §1): o `bleToken` (só no anúncio) e o `qrToken` (só no QR).
 */
export async function issueTokens(t: TestApp, who: Person): Promise<ProximityToken> {
  const response = await t.http.post('/v1/proximity/tokens').set(who.headers).expect(201);
  return ProximityTokenSchema.parse(response.body);
}

/**
 * Abre (ou mantém aberta) a tela Conectar e devolve o `qrToken` (o código do QR): o token que vale
 * no `resolve`, no pedido `qr` e no aceite `qr`. Para o anúncio, use `issueTokens(...).bleToken`.
 */
export async function issueToken(t: TestApp, who: Person): Promise<string> {
  return (await issueTokens(t, who)).qrToken;
}

export function resolveTokens(t: TestApp, who: Person, tokens: string[]) {
  return t.http.post('/v1/proximity/resolve').set(who.headers).send({ tokens });
}

/** `POST /proximity/touches`: quem chama afirma que encostou no dono de cada `bleToken`. */
export function reportTouch(t: TestApp, who: Person, tokens: string[]) {
  return t.http.post('/v1/proximity/touches').set(who.headers).send({ tokens });
}

/** Os cartões de uma resposta 200 do `touches`, com o `pairExpiresInS` (R1-10, PROX-64). */
export function touchItems(response: Response): ProximityTouchItem[] {
  return ProximityTouchResultSchema.parse(response.body).items;
}

/**
 * Encosto mútuo completo (ADR 0012 §3), como os dois aparelhos fazem: os dois abrem a tela (cada um
 * com a sua emissão), A relata o `bleToken` de B (ainda sem cartão), B relata o de A (recebe o
 * cartão de A) e A relata de novo (recebe o de B). Grava o par encostado A–B (60 s).
 */
export async function touch(t: TestApp, a: Person, b: Person) {
  const aTokens = await issueTokens(t, a);
  const bTokens = await issueTokens(t, b);
  const first = touchItems(await reportTouch(t, a, [bTokens.bleToken]).expect(200));
  const [cardOfA, ...moreForB] = touchItems(
    await reportTouch(t, b, [aTokens.bleToken]).expect(200),
  );
  const [cardOfB, ...moreForA] = touchItems(
    await reportTouch(t, a, [bTokens.bleToken]).expect(200),
  );
  if (
    first.length !== 0 ||
    cardOfA === undefined ||
    cardOfB === undefined ||
    moreForA.length + moreForB.length > 0
  ) {
    throw new Error('touch(): o encosto mútuo não casou');
  }
  return { aTokens, bTokens, cardOfA, cardOfB };
}

/**
 * `POST /connections/requests`. O padrão é o QR (`qr`), o canal do token de `issueToken`; o pedido
 * `ble` leva o `bleToken` do cartão do encosto e exige o par (`touch`).
 */
export function requestConnection(
  t: TestApp,
  who: Person,
  targetToken: string,
  method: 'ble' | 'qr' = 'qr',
) {
  return t.http.post('/v1/connections/requests').set(who.headers).send({ targetToken, method });
}

export function acceptRequest(t: TestApp, who: Person, id: string, observedToken?: string) {
  return t.http
    .post(`/v1/connections/requests/${id}/accept`)
    .set(who.headers)
    .send(observedToken === undefined ? {} : { observedToken });
}

export function parseRequest(response: Response): ConnectionRequest {
  return ConnectionRequestSchema.parse(response.body);
}

/**
 * Fluxo feliz até o pedido pendente A → B (ADR 0012 §4):
 * - `ble` (o padrão, o fluxo principal): A e B encostam (`touch`) e A pede com o `bleToken` de B;
 * - `qr`: A e B abrem a tela e A pede com o `qrToken` de B (lido do QR).
 *
 * `fromToken` é sempre o `qrToken` de A: o que B lê do QR de A para aceitar um pedido `qr` (no
 * `ble`, o aceite dispensa o token, e um token enviado é ignorado). `toToken` é o token de B usado
 * no pedido.
 */
export async function pendingRequest(
  t: TestApp,
  from: Person,
  to: Person,
  method: 'ble' | 'qr' = 'ble',
) {
  let fromTokens: ProximityToken;
  let toTokens: ProximityToken;
  if (method === 'ble') {
    ({ aTokens: fromTokens, bTokens: toTokens } = await touch(t, from, to));
  } else {
    fromTokens = await issueTokens(t, from);
    toTokens = await issueTokens(t, to);
  }
  const toToken = method === 'ble' ? toTokens.bleToken : toTokens.qrToken;
  const response = await requestConnection(t, from, toToken, method).expect(201);
  return {
    fromToken: fromTokens.qrToken,
    toToken,
    fromTokens,
    toTokens,
    request: parseRequest(response),
  };
}

/** Um token bem formado que nunca foi emitido. */
export const UNKNOWN_TOKEN = 'AAAAAAAAAAAAAAAA';

/**
 * O relógio de teste avançou mais que a validade do access token (15 min): uma sessão nova para a
 * mesma conta (os tokens de proximidade não dependem da sessão).
 */
export async function renewSession(t: TestApp, ...people: Person[]): Promise<void> {
  for (const who of people) {
    who.headers = await directSession(t.app, who.user);
  }
}
