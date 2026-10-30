import { describe, expect, it } from 'vitest';

import { findPgError } from './errors.ts';

describe('findPgError', () => {
  it('acha o SQLSTATE e a constraint na cadeia de cause', () => {
    const driverError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'users_handle_key',
    });
    const wrapped = new Error('Failed query', { cause: driverError });
    expect(findPgError(wrapped)).toEqual({ code: '23505', constraint: 'users_handle_key' });
  });

  it('ignora códigos que não são SQLSTATE (ex.: ECONNREFUSED)', () => {
    const error = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(findPgError(error)).toBeUndefined();
    expect(findPgError('texto')).toBeUndefined();
    expect(findPgError(null)).toBeUndefined();
  });

  it('constraint ausente vira undefined', () => {
    expect(findPgError({ code: '23503' })).toEqual({ code: '23503', constraint: undefined });
  });
});
