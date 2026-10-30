import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type AccountType, ErrorCode } from '@sussurro/shared';

import type { AuthenticatedRequest } from './auth-context.js';
import { REQUIRED_ACCOUNT_TYPE } from './decorators.js';
import { DomainError } from '../errors/domain-error.js';

/**
 * Guard global de tipo de conta (ADR 0008). Roda depois do guard de autenticação. Rotas sem
 * `@RequireAccountType` passam direto.
 */
@Injectable()
export class AccountTypeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AccountType | undefined>(
      REQUIRED_ACCOUNT_TYPE,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined) {
      return true;
    }
    const { auth } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (auth?.accountType !== required) {
      throw new DomainError(
        ErrorCode.ACCOUNT_TYPE_NOT_ALLOWED,
        403,
        `Rota restrita a contas ${required}`,
      );
    }
    return true;
  }
}
