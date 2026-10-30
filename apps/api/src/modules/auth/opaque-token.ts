import { createHash, randomBytes } from 'node:crypto';

/** Token opaco de 256 bits (refresh, links de e-mail), em base64url (43 caracteres). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** O banco guarda só o SHA-256 do token (ADR 0007): um vazamento do banco não dá sessões. */
export function hashOpaqueToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
