import type { UserRow } from '@sussurro/db';
import {
  type ConnectionRequest,
  ConnectionRequestSchema,
  type ProximityToken,
  ProximityTokenSchema,
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
 * (ADR 0013 §1): `{token, expiresAt, renewInS}`, o mesmo token no QR e no NFC.
 */
export async function issueTokens(t: TestApp, who: Person): Promise<ProximityToken> {
  const response = await t.http.post('/v1/proximity/tokens').set(who.headers).expect(201);
  return ProximityTokenSchema.parse(response.body);
}

/** Abre (ou mantém aberta) a tela Conectar e devolve o token (o código do QR e do NFC). */
export async function issueToken(t: TestApp, who: Person): Promise<string> {
  return (await issueTokens(t, who)).token;
}

export function resolveTokens(t: TestApp, who: Person, tokens: string[]) {
  return t.http.post('/v1/proximity/resolve').set(who.headers).send({ tokens });
}

/** `POST /connections/requests`. O método só registra como o código foi lido (ADR 0013 §2). */
export function requestConnection(
  t: TestApp,
  who: Person,
  targetToken: string,
  method: 'qr' | 'nfc' = 'qr',
) {
  return t.http.post('/v1/connections/requests').set(who.headers).send({ targetToken, method });
}

/** Aceite; sem `observedToken`, manda `{}` (o 400 `VALIDATION_ERROR` do schema). */
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
 * Fluxo feliz até o pedido pendente A → B (ADR 0013 §2): A e B abrem a tela e A pede com o token de
 * B (lido por QR ou NFC). `fromToken` é o token de A, o que B lê na tela "Aguardando" de A para
 * aceitar (D7); `toToken` é o token de B usado no pedido.
 */
export async function pendingRequest(
  t: TestApp,
  from: Person,
  to: Person,
  method: 'qr' | 'nfc' = 'qr',
) {
  const fromTokens = await issueTokens(t, from);
  const toTokens = await issueTokens(t, to);
  const response = await requestConnection(t, from, toTokens.token, method).expect(201);
  return {
    fromToken: fromTokens.token,
    toToken: toTokens.token,
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
