import { RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import type { ApiEnv } from './config/env.schema.js';

/** Prefixo das rotas de domínio (arquitetura.md §13). O health fica fora dele. */
export const API_PREFIX = 'v1';

/** Configuração comum ao main.ts e aos testes que sobem o app HTTP. */
export function configureApp(
  app: NestExpressApplication,
  env: Pick<ApiEnv, 'TRUST_PROXY_HOPS'>,
): NestExpressApplication {
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  // Atrás do ALB, o IP real (usado no rate limit) vem do X-Forwarded-For.
  if (env.TRUST_PROXY_HOPS > 0) {
    app.set('trust proxy', env.TRUST_PROXY_HOPS);
  }
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  return app;
}
