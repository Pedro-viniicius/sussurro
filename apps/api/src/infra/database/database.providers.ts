import { Logger, type Provider } from '@nestjs/common';
import { createDb, type DbHandle } from '@sussurro/db';

import { describeError } from '../../common/errors/describe-error.js';
import { AppConfig } from '../../config/config.module.js';

/** Token do `DbHandle` ({ db, pool, close }). */
export const DATABASE = Symbol('DATABASE');

export const databaseProvider: Provider<DbHandle> = {
  provide: DATABASE,
  inject: [AppConfig],
  useFactory: (config: AppConfig): DbHandle => {
    const logger = new Logger('Database');
    return createDb(config.env.DATABASE_URL, {
      applicationName: 'sussurro-api',
      onIdleError: (error) => {
        logger.warn(`Conexão ociosa do Postgres caiu: ${describeError(error)}`);
      },
    });
  },
};
