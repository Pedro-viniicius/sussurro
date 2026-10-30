import { describe, expect, it } from 'vitest';

import {
  COMMON_PASSWORDS,
  isWeakPassword,
  normalizePassword,
  PASSWORD_MAX_LENGTH,
  passwordLength,
} from './passwords.ts';

describe('política de senha (AUTH-02, A-28)', () => {
  it('[AUTH-02] 7 caracteres é fraca; 8 fora da lista passa', () => {
    expect(isWeakPassword('abcdefg')).toBe(true);
    expect(isWeakPassword('abcdefgh')).toBe(false);
  });

  it('[AUTH-02] senhas comuns são fracas, sem diferenciar maiúsculas', () => {
    for (const common of ['12345678', 'senha123', 'password', 'sussurro', 'SENHA123']) {
      expect(isWeakPassword(common)).toBe(true);
    }
    for (const entry of COMMON_PASSWORDS) {
      expect(entry).toBe(entry.toLowerCase());
    }
  });

  it('[AUTH-02] NFC: a senha com acento em NFD e em NFC normaliza igual', () => {
    const nfc = 'maçã-verde-1'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(normalizePassword(nfd)).toBe(normalizePassword(nfc));
    expect(passwordLength(nfd)).toBe(12);
  });

  it('o máximo é 128 caracteres (code points)', () => {
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(passwordLength('😀'.repeat(128))).toBe(128);
  });
});
