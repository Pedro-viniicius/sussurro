import type { ErrorEvent, EventHint, NodeOptions } from '@sentry/nestjs';
import { ErrorCode, scrubTelemetryEvent } from '@sussurro/shared';

/** O `@sentry/nestjs` não reexporta o tipo do `@sentry/core` (span do tracing em streaming). */
type StreamedSpan = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

/**
 * Erros 5xx esperados, que não vão para o Sentry (só para o log, com o código, para a métrica):
 * o Valkey fora deixa a proximidade fechada de propósito (R11, PROX-21), e cada tentativa do app
 * viraria um evento. A pendência da Fase 4a.
 */
const EXPECTED_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([ErrorCode.PROXIMITY_UNAVAILABLE]);

/** `DomainError` (ou algo com o mesmo `code`) de indisponibilidade esperada. */
export function isExpectedUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const { code } = error;
  return typeof code === 'string' && EXPECTED_UNAVAILABLE_CODES.has(code);
}

/**
 * `beforeSend` (6.7 CA1 e CA2, PERM-17): descarta a indisponibilidade esperada e limpa o evento
 * (`scrubTelemetryEvent`: sem `user`, sem corpo, cookies, query string e cabeçalhos de credencial;
 * tokens, senhas, listas e ids de relacionamento fora de qualquer parte do evento).
 */
export function beforeSend(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  if (isExpectedUnavailable(hint.originalException)) {
    return null;
  }
  return scrubTelemetryEvent(event);
}

/**
 * A mesma limpeza nos spans do tracing (o SDK 11 envia os spans em streaming; o
 * `beforeSendTransaction` só vale no modo `static`): atributos com URL perdem a query, chaves
 * sensíveis e de relacionamento saem.
 */
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

/** Amostragem do tracing entre 0 e 1; inválida = 0 (desligado). */
function sampleRate(value: string | undefined): number {
  const rate = Number(trimmed(value) ?? '0');
  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0;
}

/**
 * Opções do Sentry, ou `undefined` sem DSN (D4: sem DSN, nada é inicializado e nada sai da
 * máquina). Fase 6 (6.7): release (`SENTRY_RELEASE`, o SHA no CI), ambiente, tracing com
 * amostragem configurável e a limpeza no `beforeSend`/`beforeSendSpan`.
 *
 * O SDK 11 removeu o `sendDefaultPii`: o equivalente a `sendDefaultPii: false` (6.7 CA4) é o
 * `dataCollection` abaixo (sem usuário, cookies, corpos, query string, cabeçalhos de credencial,
 * dados de consulta ao banco nem de fila), e o `beforeSend` ainda tira o `user` de qualquer evento.
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
    // 6.8: com os pontos de OTel ligados, o Sentry registra o tracer do `@opentelemetry/api` e os
    // spans deles entram nas transações. Desligados (padrão), nenhum provider é registrado.
    enableOpenTelemetrySetup: ['true', '1'].includes(trimmed(env.OTEL_ENABLED) ?? ''),
    includeLocalVariables: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: {
          deny: ['authorization', 'cookie', 'set-cookie', 'x-refresh-token', 'x-forwarded-for'],
        },
        response: false,
      },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
    },
    beforeSend,
    beforeSendSpan,
  };
}
