import { ErrorCode } from '@sussurro/shared';
import { describe, expect, it } from 'vitest';

import { DomainError } from './domain-error.js';

describe('DomainError', () => {
  it('guarda código, status, mensagem e detalhes', () => {
    const error = new DomainError(ErrorCode.CONFLICT, 409, 'handle em uso', { field: 'handle' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DomainError');
    expect(error.code).toBe('CONFLICT');
    expect(error.httpStatus).toBe(409);
    expect(error.message).toBe('handle em uso');
    expect(error.details).toEqual({ field: 'handle' });
  });

  it('usa o status padrão do código quando não informado', () => {
    const error = new DomainError(ErrorCode.NOT_FOUND);
    expect(error.httpStatus).toBe(404);
    expect(error.message).toBe('NOT_FOUND');
    expect(error.details).toBeUndefined();
  });
});
