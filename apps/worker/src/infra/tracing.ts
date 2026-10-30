import {
  context,
  propagation,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';

/** Atributos permitidos num span: nunca ids de conta, tokens ou textos (o mesmo do Sentry). */
export type SpanAttributes = Record<string, string | number | boolean>;

/**
 * Pontos de OpenTelemetry do worker (história 6.8, infra.md §5): consumidores do SQS e chamadas ao
 * Expo. Com `OTEL_ENABLED=false` (padrão), nada é chamado no `@opentelemetry/api` (sem custo e sem
 * exportador). Ligado, o span continua o trace da API quando a mensagem trouxe o `traceparent`.
 */
export class Tracing {
  private tracer: Tracer | undefined;

  constructor(
    readonly enabled: boolean,
    private readonly serviceName = 'sussurro-worker',
  ) {}

  span<T>(
    name: string,
    attributes: SpanAttributes,
    fn: () => Promise<T>,
    carrier?: Record<string, string>,
  ): Promise<T> {
    if (!this.enabled) {
      return fn();
    }
    this.tracer ??= trace.getTracer(this.serviceName);
    const parent =
      carrier === undefined ? context.active() : propagation.extract(context.active(), carrier);
    return this.tracer.startActiveSpan(name, { attributes }, parent, async (span: Span) => {
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
}
