import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import {
  type AuthSession,
  AuthSessionSchema,
  type ForgotPasswordRequest,
  ForgotPasswordRequestSchema,
  type LoginRequest,
  LoginRequestSchema,
  NoContentSchema,
  type RefreshRequest,
  RefreshRequestSchema,
  type RegisterRequest,
  RegisterRequestSchema,
  type ResetPasswordRequest,
  ResetPasswordRequestSchema,
  type TokenPair,
  TokenPairSchema,
  type VerifyEmailRequest,
  VerifyEmailRequestSchema,
} from '@sussurro/shared';

import { AuthService } from './auth.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth, Public } from '../../common/auth/decorators.js';
import { ClientIp } from '../../common/http/client-ip.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/** Rotas `/v1/auth/*` (arquitetura.md §13, atualizado na Fase 1). */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly emailVerification: EmailVerificationService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(AuthSessionSchema)
  register(
    @Body(new ZodValidationPipe(RegisterRequestSchema)) body: RegisterRequest,
    @ClientIp() ip: string,
  ): Promise<AuthSession> {
    return this.auth.register(body, ip);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(AuthSessionSchema)
  login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @ClientIp() ip: string,
  ): Promise<AuthSession> {
    return this.auth.login(body, ip);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(TokenPairSchema)
  refresh(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) body: RefreshRequest,
  ): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  logout(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.auth.logout(auth);
  }

  @Post('logout-all')
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  logoutAll(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.auth.logoutAll(auth);
  }

  /** Sempre 202, exista o e-mail ou não (história 1.10 CA1). */
  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  @ResponseSchema(NoContentSchema)
  forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordRequestSchema)) body: ForgotPasswordRequest,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.passwordReset.request(body.email, ip);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  resetPassword(
    @Body(new ZodValidationPipe(ResetPasswordRequestSchema)) body: ResetPasswordRequest,
  ): Promise<void> {
    return this.passwordReset.reset(body.token, body.password);
  }

  /** Pública: o link pode ser aberto num aparelho sem sessão. */
  @Public()
  @Post('email/verify')
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  verifyEmail(
    @Body(new ZodValidationPipe(VerifyEmailRequestSchema)) body: VerifyEmailRequest,
  ): Promise<void> {
    return this.emailVerification.verify(body.token);
  }
}
