import type { IncomingMessage } from 'node:http';

import type { Params } from 'nestjs-pino';

import { traceIdOf } from './tracing.js';
import type { ApiEnv } from '../../config/env.schema.js';

/** Campos que nunca vão para o log (tokens, cookies). */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-refresh-token"]',
  'res.headers["set-cookie"]',
] as const;

/** `/health` e `/health/ready` são chamados o tempo todo por balanceador e orquestrador. */
export function isHealthRequest(req: Pick<IncomingMessage, 'url'>): boolean {
  return req.url === '/health' || req.url?.startsWith('/health/') === true;
}

export function buildLoggerParams(env: Pick<ApiEnv, 'LOG_LEVEL'>): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
      autoLogging: { ignore: isHealthRequest },
      // 6.8 CA1: o `traceId` (span ativo, `traceparent` recebido ou um novo) em toda linha da
      // requisição, com ou sem OpenTelemetry ligado.
      customProps: (req: IncomingMessage) => ({ traceId: traceIdOf(req) }),
      // Corpo de requisição nunca é registrado (arquitetura.md §15).
      serializers: {
        req: (req: { id: unknown; method: string; url: string; headers: unknown }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          headers: req.headers,
        }),
      },
    },
  };
}
