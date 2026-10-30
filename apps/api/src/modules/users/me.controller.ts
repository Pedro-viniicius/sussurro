import { Body, Controller, Get, Header, Patch } from '@nestjs/common';
import { type Me, MeSchema, type UpdateMeRequest, UpdateMeRequestSchema } from '@sussurro/shared';

import { UsersService } from './users.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/** Perfil próprio (história 1.5 e 1.6). `DELETE /me` fica no módulo de autenticação. */
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(MeSchema)
  getMe(@CurrentAuth() auth: AuthContext): Promise<Me> {
    return this.users.getMe(auth.userId);
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(MeSchema)
  updateMe(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(UpdateMeRequestSchema)) body: UpdateMeRequest,
  ): Promise<Me> {
    return this.users.updateMe(auth.userId, body);
  }
}
