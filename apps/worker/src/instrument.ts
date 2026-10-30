// Carregado antes de tudo: `node --import ./dist/instrument.js dist/main.js` (Sentry em ESM).
// O main.ts também o importa primeiro, para o `nest start --watch`.
import * as Sentry from '@sentry/nestjs';

import { loadRootEnvFile } from './config/env-file.js';
import { buildSentryOptions } from './infra/sentry.js';

loadRootEnvFile();

const sentryOptions = buildSentryOptions(process.env);
if (sentryOptions) {
  Sentry.init(sentryOptions);
}
