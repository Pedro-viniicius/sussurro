import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * IP do cliente para o rate limit. Atrás do ALB, o Express só confia no `X-Forwarded-For` com
 * `TRUST_PROXY_HOPS` configurado (app.setup.ts); sem isso, usa o IP da conexão.
 */
export const ClientIp = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<Request>();
  return request.ip ?? request.socket.remoteAddress ?? 'desconhecido';
});
