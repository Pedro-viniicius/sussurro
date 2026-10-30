import { Module } from '@nestjs/common';

import { MeListsController } from './own-lists.controller.js';
import { OwnListsRepository } from './own-lists.repository.js';
import { OwnListsService } from './own-lists.service.js';
import { MediaModule } from '../media/media.module.js';

/**
 * Listas próprias de conexões, criadores seguidos e bloqueados (ADR 0004, história 3.6, X.2 CA4).
 * Nada daqui é exportado: o repositório e o service só são importáveis no próprio módulo (regra de
 * lint em `apps/api/eslint.config.mjs`).
 */
@Module({
  imports: [MediaModule],
  controllers: [MeListsController],
  providers: [OwnListsRepository, OwnListsService],
})
export class OwnListsModule {}
