import type { ErrorCode } from '@sussurro/shared';

/** Erro da API no formato `{ code, message, details? }` (o `code` escolhe a mensagem na tela). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Campos com erro de validação (`details: [{ path, message }]`). */
  fieldPaths(): string[] {
    if (!Array.isArray(this.details)) {
      return [];
    }
    return this.details
      .map((item: unknown) => (item as { path?: unknown }).path)
      .filter((path): path is string => typeof path === 'string');
  }
}

/** Sem resposta do servidor (sem internet, DNS, tempo esgotado). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Sem conexão com o servidor', { cause });
    this.name = 'NetworkError';
  }
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}
