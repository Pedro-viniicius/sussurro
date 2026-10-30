import { describe, expect, it } from 'vitest';

import {
  defaultHttpStatusByCode,
  ErrorCode,
  errorCodeFromHttpStatus,
  ErrorResponseSchema,
} from './errors.ts';

describe('ErrorResponseSchema', () => {
  it('aceita { code, message } e { code, message, details }', () => {
    expect(ErrorResponseSchema.safeParse({ code: 'NOT_FOUND', message: 'x' }).success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        code: 'VALIDATION_ERROR',
        message: 'Entrada inválida',
        details: [{ path: 'email', message: 'obrigatório' }],
      }).success,
    ).toBe(true);
  });

  it('rejeita objeto sem code', () => {
    expect(ErrorResponseSchema.safeParse({ message: 'x' }).success).toBe(false);
  });

  it('rejeita code fora da lista', () => {
    expect(ErrorResponseSchema.safeParse({ code: 'NOPE', message: 'x' }).success).toBe(false);
  });

  it('rejeita message vazia', () => {
    expect(ErrorResponseSchema.safeParse({ code: 'NOT_FOUND', message: '' }).success).toBe(false);
  });
});

describe('ErrorCode', () => {
  it('cada código tem um status HTTP de erro padrão', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(defaultHttpStatusByCode[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [405, 'METHOD_NOT_ALLOWED'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [422, 'VALIDATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'],
    [502, 'INTERNAL_ERROR'],
    [503, 'SERVICE_UNAVAILABLE'],
    [418, 'BAD_REQUEST'],
  ])('status %i vira %s', (status, code) => {
    expect(errorCodeFromHttpStatus(status)).toBe(code);
  });
});
