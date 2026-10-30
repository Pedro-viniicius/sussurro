import { Clock } from '../common/clock/clock.js';

/** Relógio controlado pelos testes (A-27): nada de `sleep` para testar validade e janelas. */
export class FakeClock extends Clock {
  static readonly DEFAULT_START = new Date('2026-10-29T12:00:00.000Z');
  private current: number;

  constructor(private readonly start: Date = FakeClock.DEFAULT_START) {
    super();
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date): void {
    this.current = date.getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }

  reset(): void {
    this.current = this.start.getTime();
  }
}
