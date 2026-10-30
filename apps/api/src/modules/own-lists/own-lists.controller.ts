import { Controller, Get, Header, Query } from '@nestjs/common';
import {
  type BlocksPage,
  BlocksPageSchema,
  type ConnectionsPage,
  ConnectionsPageSchema,
  type FollowingPage,
  FollowingPageSchema,
  type OwnListQuery,
  OwnListQuerySchema,
} from '@sussurro/shared';

import { OwnListsService } from './own-lists.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth, RequireAccountType } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/**
 * As únicas rotas que devolvem listas de relacionamento (ADR 0004, história 3.6): sempre as de
 * quem chama (o `sub` do token). Não existe rota com o id ou o @ de outra conta que devolva lista
 * (PERM-09); parâmetro a mais → 400 (PERM-08). Conexões e seguidos são só de conta pessoal
 * (PERM-05); a lista de bloqueados vale para os dois tipos (o criador também bloqueia).
 */
@Controller('me')
export class MeListsController {
  constructor(private readonly lists: OwnListsService) {}

  @Get('connections')
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ConnectionsPageSchema)
  connections(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(OwnListQuerySchema)) query: OwnListQuery,
  ): Promise<ConnectionsPage> {
    return this.lists.connections(auth, query);
  }

  @Get('following')
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(FollowingPageSchema)
  following(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(OwnListQuerySchema)) query: OwnListQuery,
  ): Promise<FollowingPage> {
    return this.lists.following(auth, query);
  }

  @Get('blocks')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(BlocksPageSchema)
  blocks(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(OwnListQuerySchema)) query: OwnListQuery,
  ): Promise<BlocksPage> {
    return this.lists.blocks(auth, query);
  }
}
