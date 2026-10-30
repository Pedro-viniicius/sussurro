import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Valida (e normaliza) body, query ou params com um schema de `packages/shared`. A falha lança o
 * `ZodError`, que o filtro converte em 400 `VALIDATION_ERROR` com `details: [{ path, message }]`.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    return this.schema.parse(value);
  }
}
