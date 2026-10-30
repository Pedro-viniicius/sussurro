import { describe, expect, it } from 'vitest';

import { describeError } from './describe-error.js';

describe('describeError', () => {
  it('usa a mensagem do erro', () => {
    expect(describeError(new Error('falhou'))).toBe('falhou');
  });

  it('usa o code quando a mensagem é vazia', () => {
    const error = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(describeError(error)).toBe('ECONNREFUSED');
  });

  it('segue a cadeia de cause', () => {
    const cause = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(describeError(new Error('Failed query: select 1', { cause }))).toBe(
      'Failed query: select 1 <- ECONNREFUSED',
    );
  });

  it('aceita valores que não são Error', () => {
    expect(describeError('texto')).toBe('texto');
  });
});
