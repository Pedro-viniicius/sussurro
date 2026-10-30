import { Module } from '@nestjs/common';

import { DevController } from './dev.controller.js';
import { ConnectionsModule } from '../connections/connections.module.js';

/**
 * Rotas `/dev/*` (D15, história 4.11). O `AppModule` só importa este módulo com
 * `NODE_ENV=development` (`devModules`): a rota nem é registrada no build de produção (PROX-30).
 */
@Module({
  imports: [ConnectionsModule],
  controllers: [DevController],
})
export class DevModule {}
