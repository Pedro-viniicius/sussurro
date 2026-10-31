import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import {
  type ProximityResolveRequest,
  ProximityResolveRequestSchema,
  type ProximityResolveResult,
  ProximityResolveResultSchema,
  type ProximityToken,
  ProximityTokenSchema,
  type ProximityTouchRequest,
  ProximityTouchRequestSchema,
  type ProximityTouchResult,
  ProximityTouchResultSchema,
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
 * Tokens de proximidade, encostar e `resolve` do QR (histórias 4.2 e 4.4; ADR 0012). Só conta
 * pessoal (criador → 403, PROX-08) e com e-mail confirmado (X.3: Conectar é uma ação de escrita).
 * Respostas sem cache. Nenhuma rota recebe dado de sinal: os schemas recusam campo a mais.
 */
@Controller('proximity')
export class ProximityController {
  constructor(private readonly proximity: ProximityService) {}

  /** Os dois tokens da emissão (`bleToken` e `qrToken`) e a tela marcada como aberta. */
  @Post('tokens')
  @HttpCode(201)
  @RequireAccountType('personal')
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ProximityTokenSchema)
  issue(@CurrentAuth() auth: AuthContext): Promise<ProximityToken> {
    return this.proximity.issueToken(auth);
  }

  /** Relato do encosto: o cartão só de quem também relatou quem chama (encosto mútuo). */
  @Post('touches')
  @HttpCode(200)
  @RequireAccountType('personal')
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ProximityTouchResultSchema)
  touches(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(ProximityTouchRequestSchema)) body: ProximityTouchRequest,
  ): Promise<ProximityTouchResult> {
    return this.proximity.touches(auth, body.tokens);
  }

  /** Só o QR: o `qrToken` lido vira o cartão de quem mostrou o código. */
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
