import { Controller, Get, Param } from '@nestjs/common';
import { type PublicProfile, PublicProfileSchema } from '@sussurro/shared';

import { UsersService } from './users.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * Perfil de outra conta: criador para todos; pessoal só para o dono e as conexões; com bloqueio
   * em qualquer sentido, para ninguém (X.2). Os demais recebem o 404 de inexistente.
   */
  @Get(':handle')
  @ResponseSchema(PublicProfileSchema)
  getProfile(
    @CurrentAuth() auth: AuthContext,
    @Param('handle') handle: string,
  ): Promise<PublicProfile> {
    return this.users.getProfile(auth, handle);
  }
}
