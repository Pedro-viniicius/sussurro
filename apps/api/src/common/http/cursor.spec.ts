import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CursorCodec, deriveCursorKey } from './cursor.js';

const schema = z.object({ a: z.int(), i: z.string() });
const codec = new CursorCodec(deriveCursorKey('segredo-de-teste-com-mais-de-32-caracteres'));

function expectInvalid(run: () => unknown) {
  expect(run).toThrow(
    expect.objectContaining({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
      message: 'Cursor inválido',
    }),
  );
}

describe('CursorCodec (FEED-08)', () => {
  it('ida e volta com o mesmo tipo de lista', () => {
    const cursor = codec.encode('feed', { a: 1, i: 'x' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(codec.decode('feed', cursor, schema)).toEqual({ a: 1, i: 'x' });
  });

  it('[FEED-08] cursor de outra lista, adulterado, truncado ou sem assinatura → 400', () => {
    const cursor = codec.encode('feed', { a: 1, i: 'x' });
    const [body, signature] = cursor.split('.') as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ a: 2, i: 'x' })).toString('base64url');
    expectInvalid(() => codec.decode('comments', cursor, schema));
    expectInvalid(() => codec.decode('feed', `${forgedBody}.${signature}`, schema));
    expectInvalid(() => codec.decode('feed', body, schema));
    expectInvalid(() => codec.decode('feed', `${body}.${signature}.x`, schema));
    expectInvalid(() => codec.decode('feed', `${body}.`, schema));
    expectInvalid(() => codec.decode('feed', '%%%.@@@', schema));
  });

  it('assinatura certa com conteúdo fora do schema → 400', () => {
    expectInvalid(() => codec.decode('feed', codec.encode('feed', { a: 'x' }), schema));
    expectInvalid(() => codec.decode('feed', codec.encode('feed', 'texto'), schema));
  });

  it('outra chave (segredo do JWT trocado) não aceita o cursor', () => {
    const other = new CursorCodec(deriveCursorKey('outro-segredo-com-mais-de-32-caracteres!!'));
    expectInvalid(() => other.decode('feed', codec.encode('feed', { a: 1, i: 'x' }), schema));
  });
});
