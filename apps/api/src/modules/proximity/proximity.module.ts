import { Logger, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ProximityController } from './proximity.controller.js';
import { ProximityRepository } from './proximity.repository.js';
import { ProximityService } from './proximity.service.js';
import { MemoryProximityStore, ProximityStore, RedisProximityStore } from './proximity.store.js';
import { Clock } from '../../common/clock/clock.js';
import { AppConfig } from '../../config/config.module.js';
import { REDIS } from '../../infra/redis/redis.providers.js';
import { MediaModule } from '../media/media.module.js';
import { PoliciesModule } from '../policies/policies.module.js';

/**
 * Proximidade (arquitetura.md §5 e §11; ADR 0012): emissão e rotação dos dois tokens (BLE e QR) no
 * Redis, o relato do encosto com a observação mútua (`touches`), o `resolve` do QR e a validação
 * dos tokens (com o canal) e do par encostado para o módulo `connections`. Não grava no Postgres.
 * Todas as rotas são só de conta pessoal (PERM-05 confere).
 */
@Module({
  imports: [PoliciesModule, MediaModule],
  controllers: [ProximityController],
  providers: [
    {
      provide: ProximityStore,
      inject: [AppConfig, REDIS, Clock],
      useFactory: (config: AppConfig, redis: Redis, clock: Clock): ProximityStore => {
        if (config.env.PROXIMITY_STORE === 'memory') {
          new Logger('ProximityStore').warn(
            'PROXIMITY_STORE=memory: tokens de proximidade na memória da API (só desenvolvimento).',
          );
          return new MemoryProximityStore(clock);
        }
        return new RedisProximityStore(redis);
      },
    },
    ProximityRepository,
    ProximityService,
  ],
  exports: [ProximityService],
})
export class ProximityModule {}
