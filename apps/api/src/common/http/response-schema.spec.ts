import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  InvalidResponseError,
  MissingResponseSchemaError,
  RESPONSE_SCHEMA,
  ResponseSchemaInterceptor,
} from './response-schema.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

class FakeController {
  handler(): void {
    return undefined;
  }
}

function context(schema?: z.ZodType): ExecutionContext {
  const handler = function handler() {
    return undefined;
  };
  if (schema !== undefined) {
    Reflect.defineMetadata(RESPONSE_SCHEMA, schema, handler);
  }
  return {
    getHandler: () => handler,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;
}

const next = (body: unknown): CallHandler => ({ handle: () => of(body) });
const interceptor = new ResponseSchemaInterceptor(new Reflector());

describe('ResponseSchemaInterceptor (ADR 0004)', () => {
  it('[PERM-12] sem schema: falha fechada, antes de rodar o handler', () => {
    let ran = false;
    const handler: CallHandler = {
      handle: () => {
        ran = true;
        return of({});
      },
    };
    expect(() => interceptor.intercept(context(), handler)).toThrow(MissingResponseSchemaError);
    expect(ran).toBe(false);
  });

  it('[PERM-12] descarta campos não declarados', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(
        context(z.object({ handle: z.string() })),
        next({ handle: 'ana', passwordHash: 'x' }),
      ),
    );
    expect(result).toEqual({ handle: 'ana' });
  });

  it('[PERM-12] saída fora do schema vira erro (500 no filtro)', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(context(z.object({ handle: z.string() })), next({}))),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('ZodValidationPipe', () => {
  it('normaliza a entrada válida e lança ZodError na inválida', () => {
    const pipe = new ZodValidationPipe(z.object({ email: z.string().trim().toLowerCase() }));
    expect(pipe.transform({ email: ' A@B.c ' })).toEqual({ email: 'a@b.c' });
    expect(() => pipe.transform(undefined)).toThrow(z.ZodError);
  });
});
