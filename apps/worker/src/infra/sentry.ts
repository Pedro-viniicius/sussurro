import type { ErrorEvent, NodeOptions } from '@sentry/nestjs';
import { scrubTelemetryEvent } from '@sussurro/shared';

/** O `@sentry/nestjs` não reexporta o tipo do `@sentry/core` (span do tracing em streaming). */
type StreamedSpan = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

/**
 * `beforeSend` (6.7 CA1 e CA2, PERM-17): a mesma limpeza da API (`scrubTelemetryEvent`): sem
 * `user`, sem tokens (inclusive push tokens), senhas, listas e ids de relacionamento.
 */
export function beforeSend(event: ErrorEvent): ErrorEvent {
  return scrubTelemetryEvent(event);
}

/** A mesma limpeza nos spans do tracing (o SDK 11 envia os spans em streaming). */
export function beforeSendSpan(span: StreamedSpan): StreamedSpan {
  return scrubTelemetryEvent(span);
}

interface SentryEnv {
  SENTRY_DSN?: string | undefined;
  SENTRY_ENVIRONMENT?: string | undefined;
  SENTRY_TRACES_SAMPLE_RATE?: string | undefined;
  SENTRY_RELEASE?: string | undefined;
  OTEL_ENABLED?: string | undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result === undefined || result === '' ? undefined : result;
}

function sampleRate(value: string | undefined): number {
  const rate = Number(trimmed(value) ?? '0');
  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0;
}

/**
 * Opções do Sentry do worker, ou `undefined` sem DSN (D4: nada é inicializado nem enviado). Fase 6
 * (6.7): release, ambiente, tracing com amostragem configurável e a limpeza no `beforeSend`. O
 * equivalente a `sendDefaultPii: false` no SDK 11 é o `dataCollection` (o worker não tem
 * requisições HTTP de entrada; a fila e o banco também ficam de fora).
 */
export function buildSentryOptions(env: SentryEnv): NodeOptions | undefined {
  const dsn = trimmed(env.SENTRY_DSN);
  if (dsn === undefined) {
    return undefined;
  }
  const release = trimmed(env.SENTRY_RELEASE);
  return {
    dsn,
    environment: trimmed(env.SENTRY_ENVIRONMENT) ?? 'local',
    ...(release === undefined ? {} : { release }),
    tracesSampleRate: sampleRate(env.SENTRY_TRACES_SAMPLE_RATE),
    enableOpenTelemetrySetup: ['true', '1'].includes(trimmed(env.OTEL_ENABLED) ?? ''),
    includeLocalVariables: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { deny: ['authorization', 'cookie'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
    },
    beforeSend,
    beforeSendSpan,
  };
}
