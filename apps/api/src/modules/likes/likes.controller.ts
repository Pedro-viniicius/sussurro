import { Controller, Delete, Header, HttpCode, Param, Put } from '@nestjs/common';
import { type LikeState, LikeStateSchema } from '@sussurro/shared';

import { LikesService } from './likes.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth, RequireAccountType } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';

/**
 * `PUT` e `DELETE /posts/:id/like`, idempotentes (CNT-04). Criador não curte (A-06): 403 em
 * qualquer post, sem consultar o post (a resposta não revela se ele existe).
 */
@Controller('posts')
export class LikesController {
  constructor(private readonly likes: LikesService) {}

  @Put(':id/like')
  @HttpCode(200)
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(LikeStateSchema)
  like(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<LikeState> {
    return this.likes.like(auth, id);
  }

  @Delete(':id/like')
  @HttpCode(200)
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(LikeStateSchema)
  unlike(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<LikeState> {
    return this.likes.unlike(auth, id);
  }
}
