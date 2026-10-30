import { defaultHttpStatusByCode, type ErrorCode } from '@sussurro/shared';

/**
 * Única exceção lançada pelos services (fase-0-plano.md §6.3). O `AllExceptionsFilter`
 * a converte em `{ code, message, details? }` com o status HTTP da instância.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(
    code: ErrorCode,
    httpStatus: number = defaultHttpStatusByCode[code],
    message: string = code,
    details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}
