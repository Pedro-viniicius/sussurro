import { Body, Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import { type BlockRequest, BlockRequestSchema, NoContentSchema } from '@sussurro/shared';

import { BlocksService } from './blocks.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/**
 * Bloquear e desbloquear (X.2), para os dois tipos de conta. A lista fica em `GET /me/blocks`
 * (módulo `own-lists`). As duas rotas respondem 204 sem corpo, qualquer que seja o alvo.
 */
@Controller('me/blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Post()
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  block(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(BlockRequestSchema)) body: BlockRequest,
  ): Promise<void> {
    return this.blocks.block(auth, body);
  }

  @Delete(':handle')
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  unblock(@CurrentAuth() auth: AuthContext, @Param('handle') handle: string): Promise<void> {
    return this.blocks.unblock(auth, handle);
  }
}
