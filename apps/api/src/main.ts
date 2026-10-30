// O instrument precisa ser o primeiro import (carrega o .env e o Sentry, se houver DSN).
import './instrument.js';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { EnvValidationError, loadApiEnv, type ApiEnv } from './config/env.schema.js';
import { registerShutdownSignals } from './shutdown.js';

function readEnvOrExit(): ApiEnv {
  try {
    return loadApiEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`[api] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const env = readEnvOrExit();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    bufferLogs: true,
  });
  configureApp(app, env);
  const logger = app.get(Logger);
  registerShutdownSignals(app, logger);

  await app.listen(env.API_PORT, env.API_HOST);
  logger.log(`API ouvindo em http://${env.API_HOST}:${env.API_PORT} (${env.NODE_ENV})`);
}

await bootstrap();
