import { Injectable } from '@nestjs/common';

/**
 * Relógio injetável (A-27): `published_at` e os prazos dos jobs saem daqui, e os testes controlam
 * o tempo sem `sleep`.
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
