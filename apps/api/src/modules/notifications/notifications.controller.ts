import { Body, Controller, Delete, Get, Header, HttpCode, Post, Put, Query } from '@nestjs/common';
import {
  type MarkNotificationsReadRequest,
  MarkNotificationsReadRequestSchema,
  NoContentSchema,
  type NotificationsPage,
  NotificationsPageSchema,
  type NotificationsQuery,
  NotificationsQuerySchema,
  type RegisterPushTokenRequest,
  RegisterPushTokenRequestSchema,
  type RemovePushTokenRequest,
  RemovePushTokenRequestSchema,
  type UnreadNotifications,
  UnreadNotificationsSchema,
} from '@sussurro/shared';

import { NotificationsService } from './notifications.service.js';
import { PushTokensService } from './push-tokens.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/**
 * Notificações de quem chama (histórias 6.1, 6.2 e 6.3; ADR 0011), para os dois tipos de conta.
 * Nenhuma rota recebe id ou @ de outra conta: só existe a lista de quem chama (ADR 0004).
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(NotificationsPageSchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(NotificationsQuerySchema)) query: NotificationsQuery,
  ): Promise<NotificationsPage> {
    return this.notifications.list(auth, query);
  }

  @Get('unread-count')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(UnreadNotificationsSchema)
  unreadCount(@CurrentAuth() auth: AuthContext): Promise<UnreadNotifications> {
    return this.notifications.unreadCount(auth);
  }

  @Post('read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(UnreadNotificationsSchema)
  markRead(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(MarkNotificationsReadRequestSchema))
    body: MarkNotificationsReadRequest,
  ): Promise<UnreadNotifications> {
    return this.notifications.markRead(auth, body.upTo);
  }
}

/**
 * Push tokens do aparelho (6.4). O token vai no corpo, nunca na URL (logs de acesso e Sentry).
 * Só afetam os tokens de quem chama (CA3).
 */
@Controller('me/push-tokens')
export class PushTokensController {
  constructor(private readonly tokens: PushTokensService) {}

  @Put()
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  register(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(RegisterPushTokenRequestSchema)) body: RegisterPushTokenRequest,
  ): Promise<void> {
    return this.tokens.register(auth, body);
  }

  @Delete()
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  remove(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(RemovePushTokenRequestSchema)) body: RemovePushTokenRequest,
  ): Promise<void> {
    return this.tokens.remove(auth, body);
  }
}
