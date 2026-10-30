import { Writable } from 'node:stream';

import { pino, type LoggerOptions } from 'pino';
import { describe, expect, it } from 'vitest';

import { buildLoggerParams, isHealthRequest } from './logger.options.js';

describe('buildLoggerParams', () => {
  it('usa o LOG_LEVEL do ambiente', () => {
    const params = buildLoggerParams({ LOG_LEVEL: 'warn' });
    expect(params.pinoHttp).toMatchObject({ level: 'warn' });
  });

  it('F0-API-08: o valor de Authorization não aparece no log', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const { redact } = buildLoggerParams({ LOG_LEVEL: 'info' }).pinoHttp as LoggerOptions;
    const logger = pino({ redact: redact ?? [] }, stream);
    logger.info({
      req: { headers: { authorization: 'Bearer abc123', cookie: 'sid=xyz', host: 'localhost' } },
    });
    const output = lines.join('');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('sid=xyz');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('localhost');
  });

  it('CA7 (0.4): /health e /health/ready não geram log de acesso', () => {
    expect(isHealthRequest({ url: '/health' })).toBe(true);
    expect(isHealthRequest({ url: '/health/ready' })).toBe(true);
    expect(isHealthRequest({ url: '/v1/health-check' })).toBe(false);
    expect(isHealthRequest({ url: '/healthz' })).toBe(false);
  });

  it('[PERM-17] o corpo da requisição (senha, tokens) nunca vai para o log', () => {
    const { serializers } = buildLoggerParams({ LOG_LEVEL: 'info' }).pinoHttp as {
      serializers: { req: (req: unknown) => unknown };
    };
    const serialized = JSON.stringify(
      serializers.req({
        id: 1,
        method: 'POST',
        url: '/v1/auth/login',
        headers: { host: 'localhost' },
        body: { email: 'ana@x.com', password: 'senha-secreta', refreshToken: 'tok' },
      }),
    );
    expect(serialized).not.toContain('senha-secreta');
    expect(serialized).not.toContain('refreshToken');
    expect(serialized).not.toContain('ana@x.com');
    expect(serialized).toContain('/v1/auth/login');
  });

  it('[6.8 CA1] toda linha da requisição leva o traceId, com o OpenTelemetry desligado', () => {
    const { customProps } = buildLoggerParams({ LOG_LEVEL: 'info' }).pinoHttp as {
      customProps: (req: unknown, res: unknown) => { traceId: string };
    };
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(
      customProps({ headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } }, {}),
    ).toEqual({ traceId });
    const request = { headers: {} };
    const first = customProps(request, {}).traceId;
    expect(first).toMatch(/^[\da-f]{32}$/);
    // A linha de início e a de fim da mesma requisição têm o mesmo traceId.
    expect(customProps(request, {}).traceId).toBe(first);
  });
});
