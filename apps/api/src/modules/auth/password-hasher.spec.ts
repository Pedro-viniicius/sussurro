import { TEST_PASSWORD, TEST_PASSWORD_HASH } from '@sussurro/db/testing';
import { describe, expect, it } from 'vitest';

import { PasswordHasher } from './password-hasher.js';

const hasher = new PasswordHasher();

describe('PasswordHasher', () => {
  it('[AUTH-02] gera argon2id com os parâmetros da OWASP', async () => {
    const hash = await hasher.hash('cafe-coado-42');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(hasher.verify(hash, 'cafe-coado-42')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'cafe-coado-43')).resolves.toBe(false);
  });

  it('[AUTH-02] NFC antes do hash: NFD e NFC verificam igual', async () => {
    const nfc = 'maçã-verde-1'.normalize('NFC');
    const hash = await hasher.hash(nfc.normalize('NFD'));
    await expect(hasher.verify(hash, nfc)).resolves.toBe(true);
  });

  it('verifica o hash pré-calculado das factories (compatível com a seed)', async () => {
    await expect(hasher.verify(TEST_PASSWORD_HASH, TEST_PASSWORD)).resolves.toBe(true);
  });

  it('hash corrompido conta como senha errada, sem lançar', async () => {
    await expect(hasher.verify('nao-e-um-hash', 'x')).resolves.toBe(false);
  });

  it('[AUTH-06] a verificação fictícia (e-mail inexistente) sempre falha', async () => {
    await expect(hasher.verifyAgainstDummy('qualquer')).resolves.toBe(false);
  });
});
