import { describe, expect, it } from 'vitest';

import { bearerToken } from './auth.guard.js';
import { EMAIL_PATHS, emailLink, passwordResetEmail, verificationEmail } from './emails.js';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.js';

describe('bearerToken', () => {
  it('extrai o token de "Bearer <token>" (sem diferenciar maiúsculas)', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer   abc')).toBe('abc');
  });

  it('[AUTH-11] ausente ou em outro esquema → sem token', () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
    expect(bearerToken('Bearer a b')).toBeUndefined();
  });
});

describe('tokens opacos', () => {
  it('256 bits em base64url; o banco guarda só o SHA-256', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(token);
    expect(hashOpaqueToken(token)).toHaveLength(32);
    expect(hashOpaqueToken(token).equals(hashOpaqueToken(token))).toBe(true);
  });
});

describe('e-mails (D6)', () => {
  it('monta o deep link do app ou o link https', () => {
    expect(emailLink('sussurro://', EMAIL_PATHS.verifyEmail, 'a+b')).toBe(
      'sussurro://verificar-email?token=a%2Bb',
    );
    expect(emailLink('https://sussurro.app', EMAIL_PATHS.resetPassword, 'x')).toBe(
      'https://sussurro.app/redefinir-senha?token=x',
    );
  });

  it('textos em pt-BR com o link e a validade', () => {
    const verification = verificationEmail(
      'ana@x.com',
      'Ana',
      'sussurro://verificar-email?token=1',
    );
    expect(verification).toMatchObject({
      to: 'ana@x.com',
      subject: 'Confirme seu e-mail no Sussurro',
    });
    expect(verification.text).toContain('sussurro://verificar-email?token=1');
    expect(verification.text).toContain('24 horas');

    const reset = passwordResetEmail('ana@x.com', 'Ana', 'sussurro://redefinir-senha?token=2');
    expect(reset.text).toContain('1 hora');
    expect(reset.text).toContain('sai de todos os aparelhos');
  });
});
