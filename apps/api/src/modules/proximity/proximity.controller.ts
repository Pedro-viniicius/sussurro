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
 * Tokens de proximidade e `resolve` do código lido por QR ou NFC (histórias 4.2 e 4.4; ADR 0013).
 * Só conta pessoal (criador → 403, PROX-08) e com e-mail confirmado (X.3: Conectar é uma ação de
 * escrita). Respostas sem cache. Nenhuma rota recebe dado do aparelho: os schemas recusam campo a
 * mais.
 */
@Controller('proximity')
export class ProximityController {
  constructor(private readonly proximity: ProximityService) {}

  /** O token da emissão (o mesmo no QR e no NFC) e a tela marcada como aberta. */
  @Post('tokens')
  @HttpCode(201)
  @RequireAccountType('personal')
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ProximityTokenSchema)
  issue(@CurrentAuth() auth: AuthContext): Promise<ProximityToken> {
    return this.proximity.issueToken(auth);
  }

  /** O token lido (QR ou NFC) vira o cartão de quem mostrou o código. */
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
