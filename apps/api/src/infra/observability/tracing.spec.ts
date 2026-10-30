import {
  type Context,
  propagation,
  type Span,
  type SpanOptions,
  type TextMapPropagator,
  trace,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { traceIdFromTraceparent, traceIdOf, Tracing } from './tracing.js';

/** Tracer em memória: registra os spans criados (nenhum exportador). */
function memoryTracer() {
  const spans: { name: string; attributes: unknown; ended: boolean; status?: unknown }[] = [];
  const makeSpan = (name: string, options?: SpanOptions): Span => {
    const record = {
      name,
      attributes: options?.attributes,
      ended: false,
      status: undefined as unknown,
    };
    spans.push(record);
    return {
      end: () => {
        record.ended = true;
      },
      setStatus: (status: unknown) => {
        record.status = status;
        return undefined as unknown as Span;
      },
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
    } as unknown as Span;
  };
  const tracer = {
    startSpan: makeSpan,
    startActiveSpan: (name: string, options: SpanOptions, fn: (span: Span) => unknown) =>
      fn(makeSpan(name, options)),
  } as unknown as Tracer;
  const provider: TracerProvider = { getTracer: () => tracer };
  return { spans, provider };
}

afterEach(() => {
  vi.restoreAllMocks();
  trace.disable();
  propagation.disable();
});

describe('Tracing (6.8)', () => {
  it('[6.8 CA1] desligado: não toca no @opentelemetry/api (sem tracer, sem exportador, sem custo)', async () => {
    const getTracer = vi.spyOn(trace, 'getTracer');
    const inject = vi.spyOn(propagation, 'inject');
    const tracing = new Tracing(false, 'teste');
    await expect(tracing.span('x', {}, () => Promise.resolve(42))).resolves.toBe(42);
    await expect(firstValueFrom(tracing.observe('y', {}, () => of('ok')))).resolves.toBe('ok');
    expect(tracing.inject({})).toEqual({});
    expect(getTracer).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });

  it('ligado: cria e fecha o span (Promise e Observable), marca erro e propaga o contexto', async () => {
    const { spans, provider } = memoryTracer();
    trace.setGlobalTracerProvider(provider);
    const propagator: TextMapPropagator = {
      inject: (_context: Context, carrier: unknown) => {
        (carrier as Record<string, string>).traceparent =
          `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
      },
      extract: (context: Context) => context,
      fields: () => ['traceparent'],
    };
    propagation.setGlobalPropagator(propagator);
    const tracing = new Tracing(true, 'teste');

    await tracing.span('push.enqueue', { 'messaging.batch.count': 2 }, () => Promise.resolve());
    await expect(
      tracing.span('falha', {}, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await firstValueFrom(
      tracing.observe('HTTP GET /v1/feed', { 'http.route': '/v1/feed' }, () => of(1)),
    );
    await expect(
      firstValueFrom(tracing.observe('HTTP GET /v1/x', {}, () => throwError(() => new Error('x')))),
    ).rejects.toThrow('x');

    expect(spans.map((span) => [span.name, span.ended])).toEqual([
      ['push.enqueue', true],
      ['falha', true],
      ['HTTP GET /v1/feed', true],
      ['HTTP GET /v1/x', true],
    ]);
    expect(spans[1]?.status).toEqual({ code: 2 });
    expect(tracing.inject({})).toEqual({
      traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    });
  });
});

describe('traceId no log (6.8 CA1)', () => {
  it('usa o traceparent recebido, se válido; senão gera um (o mesmo durante a requisição)', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(traceIdOf({ headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } })).toBe(
      traceId,
    );
    const request = { headers: {} };
    const generated = traceIdOf(request);
    expect(generated).toMatch(/^[\da-f]{32}$/);
    expect(traceIdOf(request)).toBe(generated);
    expect(traceIdOf({ headers: { traceparent: 'lixo' } })).toMatch(/^[\da-f]{32}$/);
  });

  it('recusa traceparent malformado ou com trace id zerado', () => {
    expect(traceIdFromTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
    expect(traceIdFromTraceparent('00-abc-def-01')).toBeUndefined();
    expect(traceIdFromTraceparent(undefined)).toBeUndefined();
  });
});
