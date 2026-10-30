import { Controller, Delete, Get, Header, HttpCode, Param, Put, Query } from '@nestjs/common';
import {
  type CreatorSearchResult,
  CreatorSearchResultSchema,
  type FollowState,
  FollowStateSchema,
  type SearchCreatorsQuery,
  SearchCreatorsQuerySchema,
} from '@sussurro/shared';

import { FollowsService } from './follows.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth, RequireAccountType } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/**
 * Busca de criadores (histórias 3.1 e 3.2). Só conta pessoal: o criador não tem a aba Pesquisar e
 * recebe 403 (BUS-08, PERM-05). Sem sugestões: sem `q` válido, 400.
 */
@Controller('search')
export class SearchController {
  constructor(private readonly follows: FollowsService) {}

  @Get('creators')
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(CreatorSearchResultSchema)
  searchCreators(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(SearchCreatorsQuerySchema)) query: SearchCreatorsQuery,
  ): Promise<CreatorSearchResult> {
    return this.follows.search(auth, query.q);
  }
}

/**
 * Seguir e deixar de seguir (história 3.3), idempotentes. Criador → 403 `ACCOUNT_TYPE_NOT_ALLOWED`
 * antes de procurar o @ (PERM-01); @ de conta pessoal ou inexistente → o mesmo 404 (PERM-03).
 */
@Controller('creators')
export class FollowsController {
  constructor(private readonly follows: FollowsService) {}

  @Put(':handle/follow')
  @HttpCode(200)
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(FollowStateSchema)
  follow(@CurrentAuth() auth: AuthContext, @Param('handle') handle: string): Promise<FollowState> {
    return this.follows.follow(auth, handle);
  }

  @Delete(':handle/follow')
  @HttpCode(200)
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(FollowStateSchema)
  unfollow(
    @CurrentAuth() auth: AuthContext,
    @Param('handle') handle: string,
  ): Promise<FollowState> {
    return this.follows.unfollow(auth, handle);
  }
}
