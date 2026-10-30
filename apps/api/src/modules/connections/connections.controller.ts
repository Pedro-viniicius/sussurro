import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  type AcceptConnectionRequest,
  AcceptConnectionRequestSchema,
  type ConnectionRequest,
  ConnectionRequestIdSchema,
  ConnectionRequestSchema,
  type CreateConnectionRequest,
  CreateConnectionRequestSchema,
  type IncomingConnectionRequests,
  IncomingConnectionRequestsSchema,
  NoContentSchema,
} from '@sussurro/shared';
import type { Response } from 'express';

import { ConnectionsService } from './connections.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import {
  CurrentAuth,
  RequireAccountType,
  RequireVerifiedEmail,
} from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

const requestId = new ZodValidationPipe(ConnectionRequestIdSchema);

/**
 * Pedidos de conexão presencial (histórias 4.5 e 4.6, ADR 0003). Só conta pessoal (criador → 403,
 * PROX-08). Pedir e aceitar criam conexão: exigem e-mail confirmado (X.3). Recusar, cancelar e os
 * pollings, não. Nenhuma rota lista pedidos de outra conta: só os de quem chama.
 */
@Controller('connections/requests')
export class ConnectionRequestsController {
  constructor(private readonly connections: ConnectionsService) {}

  /** 201 com o pedido novo; 200 com o mesmo pendente (PROX-16) ou já `accepted` (corrida, PROX-13). */
  @Post()
  @RequireAccountType('personal')
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ConnectionRequestSchema)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateConnectionRequestSchema)) body: CreateConnectionRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConnectionRequest> {
    const result = await this.connections.createRequest(auth, body);
    response.status(result.created ? 201 : 200);
    return result.request;
  }

  /** Declarada antes de `:id` (o Express casa as rotas na ordem). */
  @Get('incoming')
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(IncomingConnectionRequestsSchema)
  incoming(@CurrentAuth() auth: AuthContext): Promise<IncomingConnectionRequests> {
    return this.connections.incoming(auth);
  }

  @Get(':id')
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ConnectionRequestSchema)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', requestId) id: string,
  ): Promise<ConnectionRequest> {
    return this.connections.get(auth, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequireAccountType('personal')
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ConnectionRequestSchema)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Param('id', requestId) id: string,
    @Body(new ZodValidationPipe(AcceptConnectionRequestSchema)) body: AcceptConnectionRequest,
  ): Promise<ConnectionRequest> {
    return this.connections.accept(auth, id, body.observedToken);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ConnectionRequestSchema)
  decline(
    @CurrentAuth() auth: AuthContext,
    @Param('id', requestId) id: string,
  ): Promise<ConnectionRequest> {
    return this.connections.decline(auth, id);
  }

  /** Cancelar (só quem pediu). Devolve o estado final: `accepted` se B aceitou antes. */
  @Delete(':id')
  @HttpCode(200)
  @RequireAccountType('personal')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ConnectionRequestSchema)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', requestId) id: string,
  ): Promise<ConnectionRequest> {
    return this.connections.cancel(auth, id);
  }
}

/**
 * Desfazer conexão (história 4.9, D8 aprovado). A lista de conexões continua só em
 * `GET /me/connections` (ADR 0004); aqui não há nenhuma rota de leitura.
 */
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Delete(':handle')
  @HttpCode(204)
  @RequireAccountType('personal')
  @ResponseSchema(NoContentSchema)
  disconnect(@CurrentAuth() auth: AuthContext, @Param('handle') handle: string): Promise<void> {
    return this.connections.disconnect(auth, handle);
  }
}
