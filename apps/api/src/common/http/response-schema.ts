import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';

export const RESPONSE_SCHEMA = Symbol('RESPONSE_SCHEMA');

/**
 * Schema Zod (de `packages/shared`) da resposta da rota (ADR 0004). O interceptor global valida a
 * saída e descarta campos não declarados. Rotas sem corpo usam `NoContentSchema`.
 */
export const ResponseSchema = (schema: z.ZodType) => SetMetadata(RESPONSE_SCHEMA, schema);

/** Rota registrada sem `@ResponseSchema`: a resposta não sai (falha fechada). */
export class MissingResponseSchemaError extends Error {
  constructor(route: string) {
    super(`Rota sem @ResponseSchema: ${route}`);
    this.name = 'MissingResponseSchemaError';
  }
}

/** O handler devolveu algo fora do schema declarado. */
export class InvalidResponseError extends Error {
  constructor(route: string, issues: string) {
    super(`Resposta fora do schema em ${route}: ${issues}`);
    this.name = 'InvalidResponseError';
  }
}

/**
 * Interceptor global das respostas (ADR 0004, história 1.8):
 * - sem schema declarado, a rota responde 500 sem executar o handler (falha fechada);
 * - com schema, `parse` descarta campos extras (ex.: `passwordHash`) e uma saída inválida vira 500.
 * Os dois erros vão para o log e para o Sentry pelo filtro de exceções.
 */
@Injectable()
export class ResponseSchemaInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const schema = this.reflector.getAllAndOverride<z.ZodType | undefined>(RESPONSE_SCHEMA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (schema === undefined) {
      throw new MissingResponseSchemaError(route);
    }
    return next.handle().pipe(
      map((body: unknown) => {
        const result = schema.safeParse(body);
        if (!result.success) {
          throw new InvalidResponseError(
            route,
            result.error.issues
              .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
              .join('; '),
          );
        }
        return result.data;
      }),
    );
  }
}
