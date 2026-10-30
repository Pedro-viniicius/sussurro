import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { ErrorCode, ErrorResponseSchema } from '@sussurro/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AllExceptionsFilter, toErrorResponse } from './all-exceptions.filter.js';
import { DomainError } from '../errors/domain-error.js';

vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

describe('toErrorResponse', () => {
  it('DomainError usa o código e o status da instância', () => {
    const { status, body } = toErrorResponse(
      new DomainError(ErrorCode.CONFLICT, 409, 'em uso', { field: 'handle' }),
    );
    expect(status).toBe(409);
    expect(body).toEqual({ code: 'CONFLICT', message: 'em uso', details: { field: 'handle' } });
  });

  it('DomainError sem detalhes não inclui a chave details', () => {
    const { body } = toErrorResponse(new DomainError(ErrorCode.FORBIDDEN));
    expect(body).not.toHaveProperty('details');
  });

  it('ZodError vira 400 VALIDATION_ERROR com { path, message }', () => {
    const result = z.object({ email: z.email() }).safeParse({ email: 'x' });
    expect(result.success).toBe(false);
    const { status, body } = toErrorResponse(result.error);
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details).toEqual([{ path: 'email', message: expect.any(String) as string }]);
  });

  it.each([
    [new NotFoundException('Cannot GET /v1/nao-existe'), 404, 'NOT_FOUND'],
    [new UnauthorizedException(), 401, 'UNAUTHORIZED'],
    [new ForbiddenException(), 403, 'FORBIDDEN'],
    [new BadRequestException('json malformado'), 400, 'BAD_REQUEST'],
    [new ServiceUnavailableException(), 503, 'SERVICE_UNAVAILABLE'],
  ])('HttpException %s vira %i %s', (exception, status, code) => {
    const mapped = toErrorResponse(exception);
    expect(mapped.status).toBe(status);
    expect(mapped.body.code).toBe(code);
    expect(ErrorResponseSchema.safeParse(mapped.body).success).toBe(true);
  });

  it('400 com várias mensagens vira VALIDATION_ERROR', () => {
    const { body } = toErrorResponse(new BadRequestException(['a obrigatório', 'b inválido']));
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details).toEqual([
      { path: '', message: 'a obrigatório' },
      { path: '', message: 'b inválido' },
    ]);
  });

  it('erro inesperado vira 500 INTERNAL_ERROR sem stack nem mensagem interna', () => {
    const { status, body } = toErrorResponse(new Error('senha do banco: hunter2'));
    expect(status).toBe(500);
    expect(body).toEqual({ code: 'INTERNAL_ERROR', message: 'Erro interno' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});

describe('toErrorResponse: banco e rate limit (Fase 1)', () => {
  it('CA4 (1.8): violação de FK vira 403, nunca 500', () => {
    const pgError = Object.assign(new Error('fk'), { code: '23503', constraint: 'x_fk' });
    const mapped = toErrorResponse(new Error('Failed query', { cause: pgError }));
    expect(mapped).toEqual({
      status: 403,
      body: { code: 'FORBIDDEN', message: 'Operação não permitida' },
    });
  });

  it('violação de unicidade não tratada pelo service vira 409', () => {
    const pgError = Object.assign(new Error('dup'), { code: '23505' });
    expect(toErrorResponse(pgError).status).toBe(409);
  });

  it('[AUTH-07] 429 leva o cabeçalho Retry-After', () => {
    const mapped = toErrorResponse(
      new DomainError(ErrorCode.RATE_LIMITED, 429, 'limite', { retryAfterS: 42 }),
    );
    expect(mapped.headers).toEqual({ 'Retry-After': '42' });
    expect(toErrorResponse(new DomainError(ErrorCode.RATE_LIMITED)).headers).toBeUndefined();
  });
});

describe('AllExceptionsFilter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function fakeHost() {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  it('responde com o status e o corpo mapeados', () => {
    const { host, status, json } = fakeHost();
    new AllExceptionsFilter().catch(new NotFoundException('x'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ code: 'NOT_FOUND', message: 'x' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('envia ao Sentry só os erros 5xx', () => {
    const { host, status } = fakeHost();
    const error = new Error('boom');
    new AllExceptionsFilter().catch(error, host);
    expect(status).toHaveBeenCalledWith(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('[6.7] 503 PROXIMITY_UNAVAILABLE é esperado: fica fora do Sentry, mas vai para o log com o código (a métrica)', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host, status, json } = fakeHost();
    new AllExceptionsFilter().catch(
      new DomainError(ErrorCode.PROXIMITY_UNAVAILABLE, 503, 'Valkey fora'),
      host,
    );
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({ code: 'PROXIMITY_UNAVAILABLE', message: 'Valkey fora' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { code: 'PROXIMITY_UNAVAILABLE', status: 503, expected: true },
      'Indisponível (esperado)',
    );
    // Outro 503 (fila fora no publish) continua indo para o Sentry.
    const other = new DomainError(ErrorCode.SERVICE_UNAVAILABLE, 503, 'fila fora');
    new AllExceptionsFilter().catch(other, fakeHost().host);
    expect(Sentry.captureException).toHaveBeenCalledWith(other);
  });
});
