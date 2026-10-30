import { randomBytes, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { UserRow } from '@sussurro/db';
import { createUser, type CreateUserOptions, TEST_PASSWORD } from '@sussurro/db/testing';
import { type AuthSession, AuthSessionSchema, type RegisterInput } from '@sussurro/shared';
import type request from 'supertest';

import { AccessTokenService } from '../../src/modules/auth/access-token.service.js';

type Http = ReturnType<typeof request>;

/** Senha válida para os cadastros pela API (8+ caracteres, fora da lista de comuns). */
export const VALID_PASSWORD = 'cafe-coado-42';

let sequence = 0;

/** Corpo de cadastro válido e único. */
export function registerBody(overrides: Partial<RegisterInput> = {}): RegisterInput {
  sequence += 1;
  const handle = `conta${String(sequence)}_${randomBytes(2).toString('hex')}`;
  return {
    email: `${handle}@example.com`,
    password: VALID_PASSWORD,
    handle,
    name: 'Pessoa de Teste',
    accountType: 'personal',
    ...overrides,
  };
}

export async function registerViaApi(
  http: Http,
  overrides: Partial<RegisterInput> = {},
): Promise<AuthSession> {
  const response = await http.post('/v1/auth/register').send(registerBody(overrides)).expect(201);
  return AuthSessionSchema.parse(response.body);
}

export async function loginViaApi(
  http: Http,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<AuthSession> {
  const response = await http.post('/v1/auth/login').send({ email, password }).expect(200);
  return AuthSessionSchema.parse(response.body);
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Conta criada direto no banco (factory) + login pela API. */
export async function signedInUser(
  http: Http,
  db: Parameters<typeof createUser>[0],
  options: CreateUserOptions = {},
) {
  const user = await createUser(db, options);
  const session = await loginViaApi(http, user.email);
  return { user, session, headers: bearer(session.tokens.accessToken) };
}

/**
 * Sessão emitida direto pelo `AccessTokenService` (sem passar pelo login). Para testes com muitas
 * contas ao mesmo tempo (CNT-04), que esbarrariam no rate limit de login por IP.
 */
export async function directSession(
  app: INestApplication,
  user: Pick<UserRow, 'id' | 'accountType'>,
): Promise<Record<string, string>> {
  const signed = await app
    .get(AccessTokenService)
    .sign({ sub: user.id, acct: user.accountType, fam: randomUUID() });
  return bearer(signed.token);
}

/** Conta criada direto no banco (factory, e-mail confirmado) + sessão direta (sem login). */
export async function directUser(
  app: INestApplication,
  db: Parameters<typeof createUser>[0],
  options: CreateUserOptions = {},
) {
  const user = await createUser(db, { emailVerifiedAt: new Date(), ...options });
  return { user, headers: await directSession(app, user) };
}
