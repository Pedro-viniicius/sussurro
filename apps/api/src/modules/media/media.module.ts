import { Module } from '@nestjs/common';

import { MediaService } from './media.service.js';

/** Upload, conferência, fila e URLs assinadas (arquitetura.md §5, módulo `media`). */
@Module({
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
