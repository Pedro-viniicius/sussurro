// E2E de autenticação (testes.md §6.6, AUTH-*). Roda com Postgres + Valkey do compose (padrão) ou
// com TEST_DB=pglite (sem Docker).
import { users } from '@sussurro/db';
import { createUser, TEST_PASSWORD } from '@sussurro/db/testing';
import {
  AuthSessionSchema,
  ErrorResponseSchema,
  MeSchema,
  TokenPairSchema,
} from '@sussurro/shared';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TEST_JWT_SECRET } from '../../src/testing/test-env.js';
import {
  bearer,
  loginViaApi,
  registerBody,
  registerViaApi,
  VALID_PASSWORD,
} from '../support/auth.js';
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

function errorCode(body: unknown): string {
  return ErrorResponseSchema.parse(body).code;
}

describe('cadastro (história 1.1)', () => {
  it('[AUTH-01] 201: conta criada com o tipo escolhido, e-mail e @ em minúsculas, sem senha nem hash', async () => {
    const response = await t.http
      .post('/v1/auth/register')
      .send(
        registerBody({
          email: '  Ana.Lima@Example.COM ',
          handle: 'Ana.Lima',
          accountType: 'creator',
        }),
      )
      .expect(201);

    const session = AuthSessionSchema.parse(response.body);
    expect(session.user).toMatchObject({
      email: 'ana.lima@example.com',
      handle: 'ana.lima',
      accountType: 'creator',
      emailVerified: false,
      counts: { posts: 0, followers: 0 },
    });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(VALID_PASSWORD);
    expect(raw).not.toContain('argon2');
    expect(raw).not.toMatch(/password/i);
    expect(response.headers['cache-control']).toBe('no-store');

    const rows = await t.database.db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('[AUTH-02] senha: 7 caracteres e senhas comuns → 400 WEAK_PASSWORD; 8 fora da lista passa', async () => {
    for (const password of ['abcdefg', '12345678', 'senha123', 'password', 'sussurro']) {
      const response = await t.http
        .post('/v1/auth/register')
        .send(registerBody({ password }))
        .expect(400);
      expect(errorCode(response.body)).toBe('WEAK_PASSWORD');
      t.clock.advance(15 * 60_000);
    }
    await t.reset();
    await t.http
      .post('/v1/auth/register')
      .send(registerBody({ password: 'abcdefgh' }))
      .expect(201);
  });

  it('[AUTH-02] senha acima de 128 caracteres → 400 VALIDATION_ERROR (antes do argon2)', async () => {
    const response = await t.http
      .post('/v1/auth/register')
      .send(registerBody({ password: 'a'.repeat(129) }))
      .expect(400);
    expect(errorCode(response.body)).toBe('VALIDATION_ERROR');
  });

  it('[AUTH-02] senha com acento cadastrada em NFD entra digitada em NFC (CA9)', async () => {
    const nfc = 'maçã-verde-1'.normalize('NFC');
    const body = registerBody({ password: nfc.normalize('NFD') });
    await t.http.post('/v1/auth/register').send(body).expect(201);
    await t.http.post('/v1/auth/login').send({ email: body.email, password: nfc }).expect(200);
  });

  it('[AUTH-03] e-mail inválido → 400; duplicado (com maiúsculas e espaço) → 409 EMAIL_TAKEN', async () => {
    const invalid = await t.http
      .post('/v1/auth/register')
      .send(registerBody({ email: 'ana@' }))
      .expect(400);
    expect(errorCode(invalid.body)).toBe('VALIDATION_ERROR');

    await registerViaApi(t.http, { email: 'ana@x.com' });
    const duplicate = await t.http
      .post('/v1/auth/register')
      .send(registerBody({ email: 'Ana@X.com ' }))
      .expect(409);
    expect(errorCode(duplicate.body)).toBe('EMAIL_TAKEN');
  });

  it('[AUTH-04] @ duplicado → 409 HANDLE_TAKEN; formato inválido → 400; reservado → 400 HANDLE_RESERVED', async () => {
    await createUser(t.database.db, { handle: 'helena' });
    const taken = await t.http
      .post('/v1/auth/register')
      .send(registerBody({ handle: 'Helena' }))
      .expect(409);
    expect(errorCode(taken.body)).toBe('HANDLE_TAKEN');

    for (const handle of ['ab', 'x'.repeat(31), 'ana-b', '...', '___']) {
      const response = await t.http
        .post('/v1/auth/register')
        .send(registerBody({ handle }))
        .expect(400);
      expect(errorCode(response.body)).toBe('VALIDATION_ERROR');
      t.clock.advance(15 * 60_000);
    }

    for (const handle of ['admin', 'sussurro', 'suporte']) {
      const response = await t.http
        .post('/v1/auth/register')
        .send(registerBody({ handle }))
        .expect(400);
      expect(errorCode(response.body)).toBe('HANDLE_RESERVED');
      t.clock.advance(15 * 60_000);
    }
  });

  it('[AUTH-05] accountType ausente → personal; fora do enum → 400', async () => {
    const { accountType: _omit, ...withoutType } = registerBody();
    const created = await t.http.post('/v1/auth/register').send(withoutType).expect(201);
    expect(MeSchema.parse(AuthSessionSchema.parse(created.body).user).accountType).toBe('personal');

    const invalid = await t.http
      .post('/v1/auth/register')
      .send({ ...registerBody(), accountType: 'admin' })
      .expect(400);
    expect(errorCode(invalid.body)).toBe('VALIDATION_ERROR');
  });

  it('[AUTH-07] 6º cadastro na hora pelo mesmo IP → 429 com Retry-After', async () => {
    for (let index = 0; index < 5; index++) {
      await registerViaApi(t.http);
    }
    const response = await t.http.post('/v1/auth/register').send(registerBody()).expect(429);
    expect(errorCode(response.body)).toBe('RATE_LIMITED');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);

    t.clock.advance(60 * 60_000 + 1);
    await registerViaApi(t.http);
  });

  it('o cadastro envia o link de verificação de e-mail (X.3)', async () => {
    const session = await registerViaApi(t.http, { email: 'nova@example.com' });
    const message = t.outbox.lastTo('nova@example.com');
    expect(message.link).toMatch(/^sussurro:\/\/verificar-email\?token=/);
    expect(session.user.emailVerified).toBe(false);
  });
});

describe('login (história 1.2)', () => {
  it('[AUTH-06] credenciais certas → access de 15 min + refresh de 30 dias', async () => {
    const user = await createUser(t.database.db, { email: 'helena@example.com' });
    const session = await loginViaApi(t.http, 'helena@example.com');
    const now = t.clock.now().getTime();
    expect(new Date(session.tokens.accessTokenExpiresAt).getTime() - now).toBe(15 * 60_000);
    expect(new Date(session.tokens.refreshTokenExpiresAt).getTime() - now).toBe(
      30 * 24 * 60 * 60_000,
    );
    expect(session.user.id).toBe(user.id);
  });

  it('[AUTH-06] senha errada e e-mail inexistente → o mesmo 401 com a mesma mensagem', async () => {
    await createUser(t.database.db, { email: 'helena@example.com' });
    const wrongPassword = await t.http
      .post('/v1/auth/login')
      .send({ email: 'helena@example.com', password: 'senha-errada-1' })
      .expect(401);
    const unknownEmail = await t.http
      .post('/v1/auth/login')
      .send({ email: 'ninguem@example.com', password: 'senha-errada-1' })
      .expect(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'E-mail ou senha incorretos.',
    });
  });

  it('CA4 (1.2): e-mail com maiúsculas e espaços entra igual', async () => {
    await createUser(t.database.db, { email: 'helena@example.com' });
    await loginViaApi(t.http, '  HELENA@Example.com ');
  });

  it('[AUTH-07] 6º login no minuto (IP + e-mail) → 429; outro e-mail do mesmo IP ainda entra', async () => {
    await createUser(t.database.db, { email: 'helena@example.com' });
    const other = await createUser(t.database.db, { email: 'caio@example.com' });
    for (let index = 0; index < 5; index++) {
      await t.http
        .post('/v1/auth/login')
        .send({ email: 'helena@example.com', password: 'errada-123' })
        .expect(401);
    }
    const blocked = await t.http
      .post('/v1/auth/login')
      .send({ email: 'helena@example.com', password: TEST_PASSWORD })
      .expect(429);
    expect(errorCode(blocked.body)).toBe('RATE_LIMITED');
    await loginViaApi(t.http, other.email);

    t.clock.advance(60_001);
    await loginViaApi(t.http, 'helena@example.com');
  });

  it('[AUTH-07] 21º login no minuto pelo mesmo IP → 429', async () => {
    for (let index = 0; index < 20; index++) {
      await t.http
        .post('/v1/auth/login')
        .send({ email: `ninguem${String(index)}@example.com`, password: 'errada-123' })
        .expect(401);
    }
    const response = await t.http
      .post('/v1/auth/login')
      .send({ email: 'outro@example.com', password: 'errada-123' })
      .expect(429);
    expect(errorCode(response.body)).toBe('RATE_LIMITED');
  });
});

describe('refresh rotativo (história 1.3)', () => {
  async function session() {
    const user = await createUser(t.database.db);
    return loginViaApi(t.http, user.email);
  }

  function refresh(refreshToken: string) {
    return t.http.post('/v1/auth/refresh').send({ refreshToken });
  }

  it('[AUTH-08] R1 → R2 e um access novo; R1 fica usado', async () => {
    const { tokens } = await session();
    // Com o relógio parado, o JWT novo teria o mesmo iat/exp e sairia idêntico.
    t.clock.advance(1_000);
    const response = await refresh(tokens.refreshToken).expect(200);
    const next = TokenPairSchema.parse(response.body);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect(next.accessToken).not.toBe(tokens.accessToken);
    await t.http.get('/v1/me').set(bearer(next.accessToken)).expect(200);
    await refresh(next.refreshToken).expect(200);
  });

  it('[AUTH-08] R1 de novo em até 20 s → novo par e o sucessor R2 é revogado (retry de rede)', async () => {
    const { tokens } = await session();
    const r2 = TokenPairSchema.parse((await refresh(tokens.refreshToken).expect(200)).body);
    t.clock.advance(20_000);
    const r3 = TokenPairSchema.parse((await refresh(tokens.refreshToken).expect(200)).body);
    expect(r3.refreshToken).not.toBe(r2.refreshToken);
    await refresh(r2.refreshToken).expect(401);
    await refresh(r3.refreshToken).expect(200);
  });

  it('[AUTH-08] R1 depois de 20 s → 401 e a família inteira é revogada; outras famílias continuam', async () => {
    const user = await createUser(t.database.db);
    const phone = await loginViaApi(t.http, user.email);
    const tablet = await loginViaApi(t.http, user.email);

    const r2 = TokenPairSchema.parse((await refresh(phone.tokens.refreshToken).expect(200)).body);
    const r3 = TokenPairSchema.parse((await refresh(r2.refreshToken).expect(200)).body);
    t.clock.advance(20_001);
    const reuse = await refresh(phone.tokens.refreshToken).expect(401);
    expect(errorCode(reuse.body)).toBe('UNAUTHORIZED');

    await refresh(r3.refreshToken).expect(401);
    await refresh(r2.refreshToken).expect(401);
    await refresh(tablet.tokens.refreshToken).expect(200);
  });

  it('[AUTH-09] refresh vencido (30 dias), inexistente ou revogado por logout → 401', async () => {
    const { tokens } = await session();
    t.clock.advance(30 * 24 * 60 * 60_000);
    await refresh(tokens.refreshToken).expect(401);

    await refresh('nao-existe').expect(401);

    t.clock.reset();
    const other = await session();
    await t.http.post('/v1/auth/logout').set(bearer(other.tokens.accessToken)).expect(204);
    await refresh(other.tokens.refreshToken).expect(401);
  });

  it('[AUTH-09] refresh de conta excluída → 401', async () => {
    const { tokens } = await session();
    await t.http
      .delete('/v1/me')
      .set(bearer(tokens.accessToken))
      .send({ password: TEST_PASSWORD })
      .expect(204);
    await refresh(tokens.refreshToken).expect(401);
  });
});

describe('JWT adulterado (AUTH-11)', () => {
  async function claimsOf() {
    const user = await createUser(t.database.db);
    const { tokens } = await loginViaApi(t.http, user.email);
    const payloadPart = tokens.accessToken.split('.')[1] ?? '';
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
      sub: string;
      fam: string;
      acct: string;
    };
    return { user, tokens, payload };
  }

  function sign(
    payload: Record<string, unknown>,
    options: { secret?: string; kid?: string; expiresInS?: number } = {},
  ) {
    const now = Math.floor(t.clock.now().getTime() / 1000);
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', kid: options.kid ?? 'k1', typ: 'JWT' })
      .setIssuer('sussurro-api')
      .setAudience('sussurro-app')
      .setIssuedAt(now)
      .setExpirationTime(now + (options.expiresInS ?? 900))
      .sign(new TextEncoder().encode(options.secret ?? TEST_JWT_SECRET));
  }

  it('[AUTH-11] o token legítimo passa (controle)', async () => {
    const { payload } = await claimsOf();
    const token = await sign({ ...payload });
    await t.http.get('/v1/me').set(bearer(token)).expect(200);
  });

  it('[AUTH-11] expirado → 401', async () => {
    const { tokens } = await claimsOf();
    t.clock.advance(15 * 60_000 + 1_000);
    const response = await t.http.get('/v1/me').set(bearer(tokens.accessToken)).expect(401);
    expect(errorCode(response.body)).toBe('UNAUTHORIZED');
  });

  it('[AUTH-11] assinatura de outro segredo, kid desconhecido e acct alterado → 401', async () => {
    const { payload } = await claimsOf();
    const otherSecret = await sign(
      { ...payload },
      { secret: 'outro-segredo-com-mais-de-32-caracteres!!' },
    );
    const unknownKid = await sign({ ...payload }, { kid: 'k9' });
    const forgedType = await sign({ ...payload, acct: 'creator' });
    for (const token of [otherSecret, unknownKid, forgedType]) {
      await t.http.get('/v1/me').set(bearer(token)).expect(401);
    }
  });

  it('[AUTH-11] alg: none → 401', async () => {
    const { payload } = await claimsOf();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        ...payload,
        iss: 'sussurro-api',
        aud: 'sussurro-app',
        exp: Math.floor(t.clock.now().getTime() / 1000) + 900,
      }),
    ).toString('base64url');
    await t.http
      .get('/v1/me')
      .set(bearer(`${header}.${body}.`))
      .expect(401);
  });

  it('[AUTH-11] sem Bearer ou com lixo → 401', async () => {
    await t.http.get('/v1/me').expect(401);
    await t.http.get('/v1/me').set({ Authorization: 'Basic abc' }).expect(401);
    await t.http.get('/v1/me').set(bearer('lixo')).expect(401);
  });
});

describe('logout (história 1.4)', () => {
  it('[AUTH-12] logout revoga só a família do aparelho; o access antigo vale até vencer', async () => {
    const user = await createUser(t.database.db);
    const phone = await loginViaApi(t.http, user.email);
    const tablet = await loginViaApi(t.http, user.email);

    await t.http.post('/v1/auth/logout').set(bearer(phone.tokens.accessToken)).expect(204);
    await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: phone.tokens.refreshToken })
      .expect(401);
    await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: tablet.tokens.refreshToken })
      .expect(200);
    // Comportamento documentado (ADR 0007): o access token segue válido até os 15 min.
    await t.http.get('/v1/me').set(bearer(phone.tokens.accessToken)).expect(200);
  });

  it('[AUTH-12] logout-all revoga todas as famílias', async () => {
    const user = await createUser(t.database.db);
    const phone = await loginViaApi(t.http, user.email);
    const tablet = await loginViaApi(t.http, user.email);

    await t.http.post('/v1/auth/logout-all').set(bearer(phone.tokens.accessToken)).expect(204);
    await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: phone.tokens.refreshToken })
      .expect(401);
    await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: tablet.tokens.refreshToken })
      .expect(401);
  });
});
