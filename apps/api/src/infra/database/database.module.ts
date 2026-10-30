import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { DbHandle } from '@sussurro/db';

import { DATABASE, databaseProvider } from './database.providers.js';

@Global()
@Module({
  providers: [databaseProvider],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}
