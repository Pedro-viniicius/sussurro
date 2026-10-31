import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import {
  type SimulateConnectionRequest,
  SimulateConnectionRequestSchema,
  type SimulatedConnectionRequest,
  SimulatedConnectionRequestSchema,
  type SimulatedTouch,
  SimulatedTouchSchema,
  type SimulateTouchRequest,
  SimulateTouchRequestSchema,
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
   * "Simular um pedido recebido" (4.11): uma persona do seed pede conexão para a conta logada (no
   * `ble`, com o par encostado gravado).
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

  /**
   * "Simular o outro celular encostando" (ADR 0012 §7): grava a observação de uma persona e devolve
   * o `bleToken` dela, para o app relatar em `POST /proximity/touches` com um aparelho só.
   */
  @Post('simulate-touch')
  @HttpCode(201)
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(SimulatedTouchSchema)
  simulateTouch(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(SimulateTouchRequestSchema)) body: SimulateTouchRequest,
  ): Promise<SimulatedTouch> {
    return this.connections.simulateTouch(auth, body.from);
  }
}
