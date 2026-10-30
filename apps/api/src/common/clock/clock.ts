import { Injectable } from '@nestjs/common';

/**
 * Relógio injetável (A-27, testes.md §3.3). Toda regra que depende de tempo (validade de tokens,
 * janelas de reuso, prazos) usa `Clock.now()` em vez de `new Date()` ou do `now()` do Postgres,
 * para os testes controlarem o tempo sem `sleep`.
 */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
