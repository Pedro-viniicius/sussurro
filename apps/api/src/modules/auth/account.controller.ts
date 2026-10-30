import { Body, Controller, Delete, HttpCode, Post } from '@nestjs/common';
import { type DeleteMeRequest, DeleteMeRequestSchema, NoContentSchema } from '@sussurro/shared';

import { AuthService } from './auth.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/**
 * Ações da própria conta que mexem em credenciais. `GET/PATCH /me` ficam no módulo de usuários;
 * a exclusão fica aqui porque verifica a senha e revoga as sessões.
 */
@Controller('me')
export class AccountController {
  constructor(
    private readonly auth: AuthService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  /** Exclusão de conta com senha (A-15; exigida pela App Store, diretriz 5.1.1(v)). */
  @Delete()
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  deleteMe(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(DeleteMeRequestSchema)) body: DeleteMeRequest,
  ): Promise<void> {
    return this.auth.deleteAccount(auth, body.password);
  }

  /** Reenvia o link de confirmação do e-mail (X.3). */
  @Post('email/verification')
  @HttpCode(202)
  @ResponseSchema(NoContentSchema)
  resendVerification(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.emailVerification.resend(auth);
  }
}
