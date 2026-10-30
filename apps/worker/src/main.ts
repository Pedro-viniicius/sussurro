// O instrument precisa ser o primeiro import (carrega o .env e o Sentry, se houver DSN).
import './instrument.js';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { EnvValidationError, loadWorkerEnv, type WorkerEnv } from './config/env.schema.js';
import { registerShutdownSignals } from './shutdown.js';
import { WorkerModule } from './worker.module.js';

function readEnvOrExit(): WorkerEnv {
  try {
    return loadWorkerEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`[worker] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const env = readEnvOrExit();
  // Application context: sem servidor HTTP (arquitetura.md §2).
  const app = await NestFactory.createApplicationContext(WorkerModule.register(env), {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  registerShutdownSignals(app, logger);
  await app.init();
}

await bootstrap();
