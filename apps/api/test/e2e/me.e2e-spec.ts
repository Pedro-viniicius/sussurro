// E2E do perfil próprio e de outros (histórias 1.5 e 1.6).
import { createUser } from '@sussurro/db/testing';
import { ErrorResponseSchema, MeSchema, PublicProfileSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signedInUser } from '../support/auth.js';
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

describe('GET /me (história 1.5)', () => {
  it('[CNT-01] conta pessoal nova: @, nome, tipo, bio e publicações/conexões/criadores = 0', async () => {
    const { user, headers } = await signedInUser(t.http, t.database.db, {
      handle: 'helena',
      name: 'Helena Souza',
      bio: 'Arquiteta.',
    });
    const response = await t.http.get('/v1/me').set(headers).expect(200);
    expect(MeSchema.parse(response.body)).toEqual({
      id: user.id,
      email: user.email,
      emailVerified: false,
      createdAt: user.createdAt.toISOString(),
      handle: 'helena',
      name: 'Helena Souza',
      bio: 'Arquiteta.',
      avatarUrl: null,
      accountType: 'personal',
      counts: { posts: 0, connections: 0, creators: 0 },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('[CNT-01] conta de criador nova: publicações e seguidores = 0', async () => {
    const { headers } = await signedInUser(t.http, t.database.db, { accountType: 'creator' });
    const response = await t.http.get('/v1/me').set(headers).expect(200);
    expect(MeSchema.parse(response.body)).toMatchObject({
      accountType: 'creator',
      counts: { posts: 0, followers: 0 },
    });
  });
});

describe('PATCH /me (história 1.6)', () => {
  it('CA1 (1.6): nome 1–60 e bio até 150 são salvos e voltam no perfil', async () => {
    const { headers } = await signedInUser(t.http, t.database.db);
    const response = await t.http
      .patch('/v1/me')
      .set(headers)
      .send({ name: '  Helena  ', bio: 'Café coado 😀' })
      .expect(200);
    expect(MeSchema.parse(response.body)).toMatchObject({ name: 'Helena', bio: 'Café coado 😀' });

    const cleared = await t.http.patch('/v1/me').set(headers).send({ bio: '' }).expect(200);
    expect(MeSchema.parse(cleared.body).bio).toBeNull();
    const me = await t.http.get('/v1/me').set(headers).expect(200);
    expect(MeSchema.parse(me.body)).toMatchObject({ name: 'Helena', bio: null });
  });

  it('[TXT-04] nome vazio, só espaços ou com 61 caracteres e bio com 151 → 400 com o campo', async () => {
    const { headers } = await signedInUser(t.http, t.database.db);
    for (const [body, field] of [
      [{ name: '' }, 'name'],
      [{ name: '   ' }, 'name'],
      [{ name: 'a'.repeat(61) }, 'name'],
      [{ bio: 'a'.repeat(151) }, 'bio'],
    ] as const) {
      const response = await t.http.patch('/v1/me').set(headers).send(body).expect(400);
      const error = ErrorResponseSchema.parse(response.body);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details).toEqual([expect.objectContaining({ path: field })]);
    }
    // 60 e 150 code points (emoji conta 1) passam.
    await t.http
      .patch('/v1/me')
      .set(headers)
      .send({ name: '😀'.repeat(60), bio: '😀'.repeat(150) })
      .expect(200);
  });

  it('[PERM-07] accountType, handle, email, id e createdAt → 400 e nada muda', async () => {
    const { user, headers } = await signedInUser(t.http, t.database.db, { handle: 'helena' });
    for (const extra of [
      { accountType: 'creator' },
      { handle: 'outra' },
      { email: 'outra@example.com' },
      { id: '01a189e0-af57-7000-85fe-2054e618fea6' },
      { createdAt: '2020-01-01T00:00:00.000Z' },
    ]) {
      const response = await t.http
        .patch('/v1/me')
        .set(headers)
        .send({ name: 'Mudou', ...extra })
        .expect(400);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
    }
    const me = MeSchema.parse((await t.http.get('/v1/me').set(headers).expect(200)).body);
    expect(me).toMatchObject({
      id: user.id,
      handle: 'helena',
      email: user.email,
      accountType: 'personal',
      name: user.name,
    });
  });
});

describe('GET /users/:handle (PERM-13)', () => {
  it('[PERM-13] dono vê o próprio perfil pessoal (200, só os campos públicos)', async () => {
    const { headers } = await signedInUser(t.http, t.database.db, { handle: 'helena' });
    const response = await t.http.get('/v1/users/helena').set(headers).expect(200);
    expect(Object.keys(response.body as object).sort()).toEqual([
      'accountType',
      'avatarUrl',
      'bio',
      'counts',
      'handle',
      'name',
    ]);
    expect(PublicProfileSchema.parse(response.body)).toMatchObject({
      handle: 'helena',
      counts: { posts: 0, connections: 0, creators: 0 },
    });
  });

  it('[PERM-13] pessoal não conectado, criador, @ inexistente, conta excluída e @ inválido → 404 idêntico', async () => {
    await createUser(t.database.db, { handle: 'helena' });
    await createUser(t.database.db, { handle: 'excluida', deletedAt: new Date() });
    const person = await signedInUser(t.http, t.database.db, { handle: 'caio.r' });
    const creator = await signedInUser(t.http, t.database.db, {
      handle: 'cozinhadabia',
      accountType: 'creator',
    });

    const bodies: unknown[] = [];
    for (const [headers, handle] of [
      [person.headers, 'helena'],
      [creator.headers, 'helena'],
      [person.headers, 'naoexiste'],
      [person.headers, 'excluida'],
      [person.headers, 'Inválido!'],
    ] as const) {
      const response = await t.http
        .get(`/v1/users/${encodeURIComponent(handle)}`)
        .set(headers)
        .expect(404);
      bodies.push(response.body);
    }
    for (const body of bodies) {
      expect(body).toEqual({ code: 'NOT_FOUND', message: 'Perfil não encontrado' });
    }
  });

  it('perfil de criador é visível a qualquer conta autenticada, sem id nem e-mail', async () => {
    await createUser(t.database.db, {
      handle: 'cozinhadabia',
      accountType: 'creator',
      bio: 'Receitas de casa.',
    });
    const person = await signedInUser(t.http, t.database.db);
    const response = await t.http.get('/v1/users/CozinhaDaBia').set(person.headers).expect(200);
    expect(response.body).toEqual({
      handle: 'cozinhadabia',
      name: expect.any(String) as string,
      bio: 'Receitas de casa.',
      avatarUrl: null,
      accountType: 'creator',
      counts: { posts: 0, followers: 0 },
      // Fase 3 (3.4): o botão Seguir/Seguindo.
      followedByMe: false,
    });
  });
});
