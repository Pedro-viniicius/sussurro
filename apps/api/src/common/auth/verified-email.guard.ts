import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@sussurro/shared';

import type { AuthenticatedRequest } from './auth-context.js';
import { REQUIRES_VERIFIED_EMAIL } from './decorators.js';
import { DomainError } from '../errors/domain-error.js';

/**
 * Guard global do bloqueio parcial de e-mail não confirmado (X.3). Roda depois da autenticação e do
 * tipo de conta; rotas sem `@RequireVerifiedEmail()` passam direto. A resposta não depende do
 * recurso pedido (existir ou não), então não vira oráculo de existência.
 */
@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(
      REQUIRES_VERIFIED_EMAIL,
      [context.getHandler(), context.getClass()],
    );
    if (required !== true) {
      return true;
    }
    const { auth } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (auth?.emailVerified !== true) {
      throw new DomainError(ErrorCode.EMAIL_NOT_VERIFIED, 403, 'Confirme o e-mail para fazer isso');
    }
    return true;
  }
}
