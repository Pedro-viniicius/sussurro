import type { UserRow } from '@sussurro/db';
import {
  type ConnectionRequest,
  ConnectionRequestSchema,
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

/** `POST /proximity/tokens`: abre (ou mantém aberta) a tela Conectar e devolve o token. */
export async function issueToken(t: TestApp, who: Person): Promise<string> {
  const response = await t.http.post('/v1/proximity/tokens').set(who.headers).expect(201);
  return ProximityTokenSchema.parse(response.body).token;
}

export function resolveTokens(t: TestApp, who: Person, tokens: string[]) {
  return t.http.post('/v1/proximity/resolve').set(who.headers).send({ tokens });
}

export function requestConnection(
  t: TestApp,
  who: Person,
  targetToken: string,
  method: 'ble' | 'qr' = 'ble',
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
 * Fluxo feliz até o pedido pendente: A e B abrem a tela, A pede com o token de B. Devolve os dois
 * tokens e o pedido.
 */
export async function pendingRequest(
  t: TestApp,
  from: Person,
  to: Person,
  method: 'ble' | 'qr' = 'ble',
) {
  const fromToken = await issueToken(t, from);
  const toToken = await issueToken(t, to);
  const response = await requestConnection(t, from, toToken, method).expect(201);
  return { fromToken, toToken, request: parseRequest(response) };
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
