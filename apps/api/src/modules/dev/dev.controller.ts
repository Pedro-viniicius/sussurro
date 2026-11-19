import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  type SimulateConnectionRequest,
  SimulateConnectionRequestSchema,
  type SimulatedConnectionRequest,
  SimulatedConnectionRequestSchema,
} from '@sussurro/shared';

import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth, RequireAccountType } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ConnectionsService } from '../connections/connections.service.js';

/**
 * Ferramentas de desenvolvimento (D15). O módulo só é registrado com `NODE_ENV=development`: em
 * `test` e `production` as rotas não existem e respondem o 404 de qualquer rota desconhecida
 * (PROX-30).
 */
@Controller('dev')
export class DevController {
  constructor(private readonly connections: ConnectionsService) {}

  /**
   * "Simular um pedido recebido" (4.11): uma persona do seed pede conexão para a conta logada, por
   * `qr` (o padrão) ou `nfc`, e devolve o token dela para o aceite (D7).
   */
  @Post('simulate-request')
  @HttpCode(201)
  @RequireAccountType('personal')
  @ResponseSchema(SimulatedConnectionRequestSchema)
  simulateRequest(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(SimulateConnectionRequestSchema)) body: SimulateConnectionRequest,
  ): Promise<SimulatedConnectionRequest> {
    return this.connections.simulateIncoming(auth, body.from, body.method);
  }
}
