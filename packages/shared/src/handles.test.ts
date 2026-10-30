import { describe, expect, it } from 'vitest';

import {
  isReservedHandle,
  isValidHandleFormat,
  normalizeHandle,
  RESERVED_HANDLES,
} from './handles.ts';

describe('formato do @ (AUTH-04, A-29)', () => {
  it.each(['ana', 'caio.r', 'cozinha_da_bia', 'a1b', 'x'.repeat(30), '_a_', '.9.'])(
    '[AUTH-04] aceita %j',
    (handle) => {
      expect(isValidHandleFormat(handle)).toBe(true);
    },
  );

  it.each([
    ['ab', '2 caracteres'],
    ['x'.repeat(31), '31 caracteres'],
    ['Ana', 'maiúscula'],
    ['ana-b', 'hífen'],
    ['ana b', 'espaço'],
    ['joão', 'acento'],
    ['...', 'só pontos'],
    ['___', 'só underscores'],
    ['._.', 'sem letra nem dígito'],
  ])('[AUTH-04] recusa %j (%s)', (handle) => {
    expect(isValidHandleFormat(handle)).toBe(false);
  });

  it('normaliza espaços e maiúsculas', () => {
    expect(normalizeHandle('  Helena ')).toBe('helena');
  });

  it('[AUTH-04] reservados, inclusive com maiúsculas e o prefixo da marca', () => {
    for (const handle of ['admin', 'sussurro', 'suporte', 'root', 'api', 'www', 'moderacao']) {
      expect(isReservedHandle(handle)).toBe(true);
    }
    expect(isReservedHandle('ADMIN')).toBe(true);
    expect(isReservedHandle('sussurro.oficial')).toBe(true);
    expect(isReservedHandle('helena')).toBe(false);
  });

  it('a lista de reservados está toda em minúsculas', () => {
    for (const handle of RESERVED_HANDLES) {
      expect(handle).toBe(handle.toLowerCase());
    }
  });
});
