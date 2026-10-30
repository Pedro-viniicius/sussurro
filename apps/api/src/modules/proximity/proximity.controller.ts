import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import {
  type ProximityResolveRequest,
  ProximityResolveRequestSchema,
  type ProximityResolveResult,
  ProximityResolveResultSchema,
  type ProximityToken,
  ProximityTokenSchema,
} from '@sussurro/shared';

import { ProximityService } from './proximity.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import {
  CurrentAuth,
  RequireAccountType,
  RequireVerifiedEmail,
} from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/**
 * Tokens de proximidade e `resolve` (histórias 4.2 e 4.4). Só conta pessoal (criador → 403,
 * PROX-08) e com e-mail confirmado (X.3: Conectar é uma ação de escrita). Respostas sem cache.
 */
@Controller('proximity')
export class ProximityController {
  constructor(private readonly proximity: ProximityService) {}

  @Post('tokens')
  @HttpCode(201)
  @RequireAccountType('personal')
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ProximityTokenSchema)
  issue(@CurrentAuth() auth: AuthContext): Promise<ProximityToken> {
    return this.proximity.issueToken(auth);
  }

  @Post('resolve')
  @HttpCode(200)
  @RequireAccountType('personal')
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ProximityResolveResultSchema)
  resolve(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(ProximityResolveRequestSchema)) body: ProximityResolveRequest,
  ): Promise<ProximityResolveResult> {
    return this.proximity.resolve(auth, body.tokens);
  }
}
