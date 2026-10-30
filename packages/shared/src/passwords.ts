/**
 * Política de senha (ADR 0007, A-28): mínimo de 8 e máximo de 128 caracteres, contados em code
 * points depois de normalizar em NFC (a mesma senha com acento digitada no iOS e no Android vira os
 * mesmos bytes), e fora da lista de senhas comuns.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Senhas comuns recusadas no cadastro e na redefinição (comparação sem maiúsculas). */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '00000000',
  '11111111',
  '12341234',
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  '123123123',
  '123qweasd',
  '147258369',
  '1q2w3e4r',
  '1qaz2wsx',
  '87654321',
  '88888888',
  'a1b2c3d4',
  'aa123456',
  'abc12345',
  'abcd1234',
  'admin123',
  'asdfghjk',
  'baseball',
  'batman123',
  'botafogo',
  'brasil123',
  'corinthians',
  'cruzeiro',
  'flamengo',
  'football',
  'gremio123',
  'iloveyou',
  'internacional',
  'minhasenha',
  'mudar123',
  'palmeiras',
  'password',
  'password1',
  'password123',
  'princesa',
  'q1w2e3r4',
  'qazwsxed',
  'qwerty123',
  'qwertyui',
  'santos123',
  'saopaulo',
  'senha123',
  'senha1234',
  'senha@123',
  'senhaforte',
  'senhasenha',
  'sunshine',
  'superman',
  'sussurro',
  'sussurro123',
  'teamo123',
  'trocar123',
  'trustno1',
  'vasco123',
  'welcome1',
  'whatever',
  'zaq12wsx',
]);

/** NFC antes de contar, comparar e gerar o hash. */
export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

/** Tamanho em code points depois do NFC. */
export function passwordLength(password: string): number {
  let length = 0;
  // O iterador de string percorre code points (pares substitutos contam 1).
  for (const _char of normalizePassword(password)) {
    length++;
  }
  return length;
}

/** Curta demais ou comum: o cadastro e a redefinição respondem 400 `WEAK_PASSWORD`. */
export function isWeakPassword(password: string): boolean {
  const normalized = normalizePassword(password);
  return (
    passwordLength(normalized) < PASSWORD_MIN_LENGTH ||
    COMMON_PASSWORDS.has(normalized.toLowerCase())
  );
}
