import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@sussurro/shared';

import { AccessTokenService } from './access-token.service.js';
import { CredentialsRepository } from './credentials.repository.js';
import type { AuthenticatedRequest } from '../../common/auth/auth-context.js';
import { IS_PUBLIC } from '../../common/auth/decorators.js';
import { DomainError } from '../../common/errors/domain-error.js';

const unauthorized = (message: string) => new DomainError(ErrorCode.UNAUTHORIZED, 401, message);

/** Extrai o token de `Authorization: Bearer <token>`. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Guard global de autenticação: toda rota exige access token válido, exceto as marcadas com
 * `@Public()` (PERM-18). Também confere no banco que a conta existe, não foi excluída e tem o tipo
 * do claim `acct`: o access token de uma conta excluída deixa de valer na hora (CONTA-07).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly credentials: CredentialsRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      throw unauthorized('Token de acesso ausente');
    }
    const claims = await this.accessTokens.verify(token);
    const subject = await this.credentials.findAuthSubject(claims.sub);
    if (subject?.accountType !== claims.acct) {
      throw unauthorized('Conta inexistente ou excluída');
    }
    request.auth = {
      userId: subject.id,
      accountType: subject.accountType,
      familyId: claims.fam,
      emailVerified: subject.emailVerifiedAt !== null,
    };
    return true;
  }
}
