import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AccountType } from '@sussurro/shared';

import type { AuthContext, AuthenticatedRequest } from './auth-context.js';

export const IS_PUBLIC = Symbol('IS_PUBLIC');
export const REQUIRED_ACCOUNT_TYPE = Symbol('REQUIRED_ACCOUNT_TYPE');
export const REQUIRES_VERIFIED_EMAIL = Symbol('REQUIRES_VERIFIED_EMAIL');

/**
 * Rota sem autenticação. Todas as outras exigem access token válido (PERM-18): o guard é global,
 * então esquecer o decorator deixa a rota fechada, nunca aberta.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restringe a rota a um tipo de conta; o outro tipo recebe 403 `ACCOUNT_TYPE_NOT_ALLOWED`. */
export const RequireAccountType = (accountType: AccountType) =>
  SetMetadata(REQUIRED_ACCOUNT_TYPE, accountType);

/**
 * Ação que exige e-mail confirmado (bloqueio parcial da história X.3): sem confirmação, 403
 * `EMAIL_NOT_VERIFIED`. Fase 2: criar rascunho, post de texto, publicar e comentar; Fase 4: pedir
 * conexão. Ler, curtir, perfil e conta continuam liberados.
 */
export const RequireVerifiedEmail = () => SetMetadata(REQUIRES_VERIFIED_EMAIL, true);

/** Contexto de quem chama. Só existe em rotas autenticadas. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.auth === undefined) {
      throw new Error('@CurrentAuth() usado numa rota sem autenticação');
    }
    return request.auth;
  },
);
