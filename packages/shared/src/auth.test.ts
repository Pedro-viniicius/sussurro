import { describe, expect, it } from 'vitest';

import {
  AuthSessionSchema,
  DeleteMeRequestSchema,
  EmailSchema,
  HandleSchema,
  LoginRequestSchema,
  PasswordInputSchema,
  RegisterRequestSchema,
} from './auth.ts';

const validRegister = {
  email: 'ana@exemplo.com',
  password: 'cafe-coado-42',
  handle: 'ana',
  name: 'Ana Lima',
  accountType: 'personal',
};

describe('EmailSchema', () => {
  it('[AUTH-03] tira espaços e converte para minúsculas', () => {
    expect(EmailSchema.parse(' Ana@X.com ')).toBe('ana@x.com');
  });

  it('[AUTH-03] formato inválido falha', () => {
    expect(EmailSchema.safeParse('ana@').success).toBe(false);
    expect(EmailSchema.safeParse('').success).toBe(false);
  });
});

describe('PasswordInputSchema', () => {
  it('[AUTH-02] normaliza em NFC', () => {
    const nfd = 'maçã-verde-1'.normalize('NFD');
    expect(PasswordInputSchema.parse(nfd)).toBe('maçã-verde-1'.normalize('NFC'));
  });

  it('[AUTH-02] acima de 128 caracteres falha na validação (antes do argon2)', () => {
    expect(PasswordInputSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(PasswordInputSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('vazia falha', () => {
    expect(PasswordInputSchema.safeParse('').success).toBe(false);
  });
});

describe('HandleSchema', () => {
  it('[AUTH-04] converte para minúsculas', () => {
    expect(HandleSchema.parse(' Caio.R ')).toBe('caio.r');
  });

  it.each(['ab', 'x'.repeat(31), 'ana-b', '...', '___'])('[AUTH-04] recusa %j', (handle) => {
    expect(HandleSchema.safeParse(handle).success).toBe(false);
  });
});

describe('RegisterRequestSchema', () => {
  it('[AUTH-01] aceita o cadastro válido', () => {
    expect(RegisterRequestSchema.parse(validRegister)).toMatchObject({
      email: 'ana@exemplo.com',
      handle: 'ana',
      accountType: 'personal',
    });
  });

  it('[AUTH-05] sem accountType vale personal; fora do enum falha', () => {
    const { accountType: _omit, ...withoutType } = validRegister;
    expect(RegisterRequestSchema.parse(withoutType).accountType).toBe('personal');
    expect(
      RegisterRequestSchema.safeParse({ ...validRegister, accountType: 'admin' }).success,
    ).toBe(false);
  });

  it('[TXT-04] nome vazio, só espaços ou com 61 caracteres falha; 60 passa', () => {
    expect(RegisterRequestSchema.safeParse({ ...validRegister, name: '' }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...validRegister, name: '   ' }).success).toBe(false);
    expect(
      RegisterRequestSchema.safeParse({ ...validRegister, name: 'a'.repeat(61) }).success,
    ).toBe(false);
    expect(
      RegisterRequestSchema.safeParse({ ...validRegister, name: '😀'.repeat(60) }).success,
    ).toBe(true);
  });
});

describe('LoginRequestSchema e DeleteMeRequestSchema', () => {
  it('login normaliza o e-mail', () => {
    expect(LoginRequestSchema.parse({ email: 'ANA@x.com', password: 'x' }).email).toBe('ana@x.com');
  });

  it('[CONTA-01] DELETE /me exige a senha', () => {
    expect(DeleteMeRequestSchema.safeParse({}).success).toBe(false);
    expect(DeleteMeRequestSchema.safeParse({ password: 'cafe-coado-42' }).success).toBe(true);
  });
});

describe('AuthSessionSchema', () => {
  it('remove campos não declarados (ex.: passwordHash)', () => {
    const parsed = AuthSessionSchema.parse({
      user: {
        id: '01a189e0-af57-7000-85fe-2054e618fea6',
        email: 'ana@exemplo.com',
        emailVerified: false,
        createdAt: '2026-10-29T12:00:00.000Z',
        handle: 'ana',
        name: 'Ana',
        bio: null,
        avatarUrl: null,
        accountType: 'personal',
        counts: { posts: 0, connections: 0, creators: 0 },
        passwordHash: '$argon2id$...',
      },
      tokens: {
        accessToken: 'a',
        accessTokenExpiresAt: '2026-10-29T12:15:00.000Z',
        refreshToken: 'r',
        refreshTokenExpiresAt: '2026-11-28T12:00:00.000Z',
      },
    });
    expect(parsed.user).not.toHaveProperty('passwordHash');
  });
});
