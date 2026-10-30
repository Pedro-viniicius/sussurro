import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { findPgError, PgErrorCode } from '@sussurro/db';
import {
  describeSafeError,
  ErrorCode,
  errorCodeFromHttpStatus,
  type ErrorResponse,
  sanitizeError,
  type ValidationIssue,
} from '@sussurro/shared';
import type { Response } from 'express';
import { ZodError } from 'zod';

import { isExpectedUnavailable } from '../../infra/observability/sentry.js';
import { DomainError } from '../errors/domain-error.js';

export interface MappedError {
  status: number;
  body: ErrorResponse;
  /** Cabeçalhos extras (ex.: `Retry-After` no 429). */
  headers?: Record<string, string>;
}

function messagesFromHttpResponse(response: string | object): string[] {
  if (typeof response === 'string') {
    return [response];
  }
  const { message } = response as { message?: unknown };
  if (typeof message === 'string') {
    return [message];
  }
  if (Array.isArray(message)) {
    return message.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function fromZodError(error: ZodError): MappedError {
  const details: ValidationIssue[] = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return {
    status: HttpStatus.BAD_REQUEST,
    body: { code: ErrorCode.VALIDATION_ERROR, message: 'Entrada inválida', details },
  };
}

function fromHttpException(exception: HttpException): MappedError {
  const status = exception.getStatus();
  const messages = messagesFromHttpResponse(exception.getResponse());
  // Validação nativa do Nest (pipes/Standard Schema) devolve 400 com lista de mensagens.
  if (status === 400 && messages.length > 1) {
    return {
      status,
      body: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Entrada inválida',
        details: messages.map((message) => ({ path: '', message })),
      },
    };
  }
  const code = errorCodeFromHttpStatus(status);
  return {
    status,
    body: { code, message: messages[0] ?? exception.message },
  };
}

function retryAfterOf(error: DomainError): number | undefined {
  if (error.code !== ErrorCode.RATE_LIMITED) {
    return undefined;
  }
  const { retryAfterS } = (error.details ?? {}) as { retryAfterS?: unknown };
  return typeof retryAfterS === 'number' ? retryAfterS : undefined;
}

/**
 * Erros de integridade que escaparam dos services (defesa em profundidade, ADR 0008): FK violada
 * vira 403 e unicidade vira 409, nunca 500. Os services tratam os casos com mensagem própria
 * (ex.: e-mail em uso) antes de chegar aqui.
 */
function fromPgError(exception: unknown): MappedError | undefined {
  const pgError = findPgError(exception);
  if (pgError?.code === PgErrorCode.FOREIGN_KEY_VIOLATION) {
    return {
      status: HttpStatus.FORBIDDEN,
      body: { code: ErrorCode.FORBIDDEN, message: 'Operação não permitida' },
    };
  }
  if (pgError?.code === PgErrorCode.UNIQUE_VIOLATION) {
    return {
      status: HttpStatus.CONFLICT,
      body: { code: ErrorCode.CONFLICT, message: 'Conflito com um registro existente' },
    };
  }
  return undefined;
}

/**
 * Converte qualquer exceção no formato único `{ code, message, details? }`
 * (fase-0-plano.md §6.3). Erros inesperados viram 500 sem stack no corpo.
 */
export function toErrorResponse(exception: unknown): MappedError {
  if (exception instanceof DomainError) {
    const body: ErrorResponse = { code: exception.code, message: exception.message };
    if (exception.details !== undefined) {
      body.details = exception.details;
    }
    const retryAfterS = retryAfterOf(exception);
    return {
      status: exception.httpStatus,
      body,
      ...(retryAfterS === undefined ? {} : { headers: { 'Retry-After': String(retryAfterS) } }),
    };
  }
  if (exception instanceof ZodError) {
    return fromZodError(exception);
  }
  if (exception instanceof HttpException) {
    return fromHttpException(exception);
  }
  const pgError = fromPgError(exception);
  if (pgError !== undefined) {
    return pgError;
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: ErrorCode.INTERNAL_ERROR, message: 'Erro interno' },
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body, headers } = toErrorResponse(exception);
    if (status >= 500 && isExpectedUnavailable(exception)) {
      // Indisponibilidade esperada (Valkey fora, R11): só o log, com o código e o status, que é a
      // métrica (filtro do CloudWatch por `code`). Fora do Sentry (pendência da Fase 4a).
      this.logger.warn({ code: body.code, status, expected: true }, 'Indisponível (esperado)');
    } else if (status >= 500) {
      // PERM-17: nunca o erro original. O `DrizzleQueryError` traz os valores da consulta (e-mail,
      // hash da senha, nome, textos) na mensagem, no stack e nos `params`. Log e Sentry recebem a
      // versão limpa: o SQL, a mensagem e o SQLSTATE do driver e o stack só com os frames.
      const safe = sanitizeError(exception);
      this.logger.error(describeSafeError(safe, { withStack: true }));
      // Sem DSN o Sentry não foi inicializado e isto não faz nada (decisão D4).
      Sentry.captureException(safe);
    }
    const response = host.switchToHttp().getResponse<Response>();
    if (headers !== undefined) {
      response.set(headers);
    }
    response.status(status).json(body);
  }
}
