import { Clock } from '../infra/clock.js';

/** Relógio controlado pelos testes (A-27). */
export class FakeClock extends Clock {
  private current: number;

  constructor(start: Date = new Date('2026-10-29T12:00:00.000Z')) {
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
}
