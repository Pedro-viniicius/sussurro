import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { ErrorCode } from '@sussurro/shared';
import type { z } from 'zod';

import { DomainError } from '../errors/domain-error.js';

/** Tamanho da assinatura no cursor (128 bits de HMAC-SHA256). */
const SIGNATURE_BYTES = 16;

/** Mesmo 400 para qualquer cursor ruim (base64 inválido, adulterado, de outra lista ou aba). */
export function invalidCursor(): DomainError {
  return new DomainError(ErrorCode.VALIDATION_ERROR, 400, 'Cursor inválido', [
    { path: 'cursor', message: 'Cursor inválido.' },
  ]);
}

/**
 * Chave dos cursores derivada do segredo do JWT (HKDF-SHA256, com rótulo próprio): sem variável
 * nova e sem reaproveitar o segredo cru. Trocar o segredo do JWT invalida os cursores em aberto
 * (o app recomeça da primeira página).
 */
export function deriveCursorKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'sussurro', 'cursor-v1', 32));
}

/**
 * Cursores opacos e assinados (ADR 0005, FEED-08): `base64url(json).base64url(hmac)`. O `kind`
 * entra na assinatura, então o cursor de uma lista não vale em outra; o conteúdo é validado por um
 * schema depois da assinatura. O app só repassa o valor.
 */
export class CursorCodec {
  constructor(private readonly key: Buffer) {}

  private signature(kind: string, body: string): Buffer {
    return createHmac('sha256', this.key)
      .update(`${kind}.${body}`)
      .digest()
      .subarray(0, SIGNATURE_BYTES);
  }

  encode(kind: string, payload: unknown): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.signature(kind, body).toString('base64url')}`;
  }

  decode<T extends z.ZodType>(kind: string, cursor: string, schema: T): z.output<T> {
    const [body, signature, ...rest] = cursor.split('.');
    if (body === undefined || signature === undefined || rest.length > 0) {
      throw invalidCursor();
    }
    const given = Buffer.from(signature, 'base64url');
    const expected = this.signature(kind, body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw invalidCursor();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw invalidCursor();
    }
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw invalidCursor();
    }
    return result.data;
  }
}
