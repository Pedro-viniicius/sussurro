import { Module } from '@nestjs/common';

import { AccessPolicyService } from './access-policy.service.js';
import { RelationsRepository } from './relations.repository.js';
import { ConnectionsRepository } from '../connections/connections.repository.js';

/**
 * `ConnectionsRepository` (só leitura aqui: `hasRecentRequestBetween`) é registrado também neste
 * módulo, sem importar o `ConnectionsModule` (que importa este): o repository não guarda estado.
 */
@Module({
  providers: [RelationsRepository, ConnectionsRepository, AccessPolicyService],
  exports: [AccessPolicyService],
})
export class PoliciesModule {}
