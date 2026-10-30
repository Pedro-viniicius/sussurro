import { randomBytes } from 'node:crypto';

import {
  context,
  propagation,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { Observable } from 'rxjs';

/** `traceparent` do W3C: versão, trace id (32 hex), span id (16 hex) e flags. */
const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;
const ZERO_TRACE_ID = '0'.repeat(32);

/** Trace id de um `traceparent` válido (nunca o de zeros), ou `undefined`. */
export function traceIdFromTraceparent(header: unknown): string | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  const traceId = match?.[1];
  return traceId === undefined || traceId === ZERO_TRACE_ID ? undefined : traceId;
}

/** Trace id do span ativo, se houver um válido (Sentry com tracing ou um SDK do OTel). */
function activeTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext !== undefined && trace.isSpanContextValid(spanContext)
    ? spanContext.traceId
    : undefined;
}

const TRACE_ID = Symbol('traceId');

interface TraceableRequest {
  headers: Record<string, string | string[] | undefined>;
  [TRACE_ID]?: string;
}

/**
 * Trace id da requisição, para o log (6.8 CA1): o do span ativo, o do `traceparent` recebido ou um
 * novo (128 bits aleatórios). Calculado uma vez por requisição, com ou sem OTel ligado.
 */
export function traceIdOf(request: TraceableRequest): string {
  const cached = request[TRACE_ID];
  if (cached !== undefined) {
    return cached;
  }
  const traceId =
    activeTraceId() ??
    traceIdFromTraceparent(request.headers.traceparent) ??
    randomBytes(16).toString('hex');
  request[TRACE_ID] = traceId;
  return traceId;
}

/** Atributos permitidos num span: nunca ids de conta, tokens ou listas (o mesmo do Sentry). */
export type SpanAttributes = Record<string, string | number | boolean>;

/**
 * Pontos de OpenTelemetry (história 6.8, infra.md §5). Com `OTEL_ENABLED=false` (padrão) nada é
 * chamado no `@opentelemetry/api`: `span` só executa a função e `inject` não mexe no carrier, sem
 * custo mensurável e sem exportador. Ligado, usa o tracer global: no-op sem SDK; com o Sentry e
 * tracing, os spans entram nas transações dele. Um SDK/collector (ADOT) pode ser registrado depois
 * sem mudar quem chama.
 */
export class Tracing {
  private tracer: Tracer | undefined;

  constructor(
    readonly enabled: boolean,
    private readonly serviceName: string,
  ) {}

  /** Executa `fn` dentro de um span (ligado) ou só executa (desligado). Erros marcam o span. */
  span<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) {
      return fn();
    }
    this.tracer ??= trace.getTracer(this.serviceName);
    return this.tracer.startActiveSpan(name, { attributes }, async (span: Span) => {
      try {
        return await fn();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Versão para `Observable` (interceptor HTTP do Nest): o span abre na inscrição, fica ativo
   * durante o handler e fecha no fim ou no erro. Desligado, devolve o próprio `Observable`.
   */
  observe<T>(name: string, attributes: SpanAttributes, source: () => Observable<T>): Observable<T> {
    if (!this.enabled) {
      return source();
    }
    this.tracer ??= trace.getTracer(this.serviceName);
    const tracer = this.tracer;
    return new Observable<T>((subscriber) => {
      const span = tracer.startSpan(name, { attributes });
      return context.with(trace.setSpan(context.active(), span), () =>
        source().subscribe({
          next: (value) => {
            subscriber.next(value);
          },
          error: (error: unknown) => {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            subscriber.error(error);
          },
          complete: () => {
            span.end();
            subscriber.complete();
          },
        }),
      );
    });
  }

  /** Grava o contexto ativo (`traceparent`) no carrier, ex.: atributos da mensagem do SQS. */
  inject(carrier: Record<string, string>): Record<string, string> {
    if (this.enabled) {
      propagation.inject(context.active(), carrier);
    }
    return carrier;
  }
}
