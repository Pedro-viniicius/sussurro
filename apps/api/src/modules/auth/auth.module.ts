import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AccessTokenService } from './access-token.service.js';
import { AccountController } from './account.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { CredentialsRepository } from './credentials.repository.js';
import { EmailTokensRepository } from './email-tokens.repository.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordHasher } from './password-hasher.js';
import { PasswordResetService } from './password-reset.service.js';
import { SessionsRepository } from './sessions.repository.js';
import { SessionsService } from './sessions.service.js';
import { AccountTypeGuard } from '../../common/auth/account-type.guard.js';
import { VerifiedEmailGuard } from '../../common/auth/verified-email.guard.js';
import { CommentsModule } from '../comments/comments.module.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { LikesModule } from '../likes/likes.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { UsersModule } from '../users/users.module.js';

@Module({
  imports: [UsersModule, LikesModule, CommentsModule, ConnectionsModule, NotificationsModule],
  controllers: [AuthController, AccountController],
  providers: [
    AccessTokenService,
    PasswordHasher,
    CredentialsRepository,
    SessionsRepository,
    EmailTokensRepository,
    SessionsService,
    EmailVerificationService,
    PasswordResetService,
    AuthService,
    // Guards globais, nesta ordem: autenticação (PERM-18), tipo de conta (ADR 0008) e e-mail
    // confirmado (X.3, só nas rotas com @RequireVerifiedEmail).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AccountTypeGuard },
    { provide: APP_GUARD, useClass: VerifiedEmailGuard },
  ],
  exports: [SessionsService],
})
export class AuthModule {}
