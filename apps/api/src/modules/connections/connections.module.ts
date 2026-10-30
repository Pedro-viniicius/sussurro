import { Module } from '@nestjs/common';

import { ConnectionRequestsController, ConnectionsController } from './connections.controller.js';
import { ConnectionsRepository } from './connections.repository.js';
import { ConnectionsService } from './connections.service.js';
import { MediaModule } from '../media/media.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { ProximityModule } from '../proximity/proximity.module.js';
import { UsersModule } from '../users/users.module.js';

/**
 * Pedidos de conexão, aceite, recusa, cancelamento e desfazer conexão (arquitetura.md §5). A
 * prova de presença vem do `ProximityModule`. Todas as rotas são só de conta pessoal (PERM-05). O
 * service é exportado para o logout e a exclusão de conta (PROX-27) e para a simulação em dev.
 */
@Module({
  imports: [ProximityModule, PoliciesModule, UsersModule, MediaModule, NotificationsModule],
  controllers: [ConnectionRequestsController, ConnectionsController],
  providers: [ConnectionsRepository, ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
