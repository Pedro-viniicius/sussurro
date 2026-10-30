import {
  NoContentSchema,
  type NotificationsPage,
  NotificationsPageSchema,
  PAGE_SIZE_DEFAULT,
  type PushPlatform,
  type UnreadNotifications,
  UnreadNotificationsSchema,
} from '@sussurro/shared';

import type { ApiClient } from '../../lib/api/client';
import { withQuery } from '../../lib/api/query';

/**
 * Rotas da Fase 6 (contrato em `packages/shared/src/notifications.ts`, arquitetura.md §13). Toda
 * resposta passa pelo schema Zod.
 */

/** `GET /notifications?cursor=&limit=`: só as de quem chama, da mais recente para a mais antiga. */
export function fetchNotifications(api: ApiClient, cursor?: string): Promise<NotificationsPage> {
  return api.request(withQuery('/v1/notifications', { cursor, limit: PAGE_SIZE_DEFAULT }), {
    schema: NotificationsPageSchema,
  });
}

/** Ponto azul do coração (6.2). */
export function fetchUnreadCount(api: ApiClient): Promise<UnreadNotifications> {
  return api.request('/v1/notifications/unread-count', { schema: UnreadNotificationsSchema });
}

/** Marca como lidas até `upTo` (o `updatedAt` da primeira mostrada); devolve as que sobraram. */
export function markNotificationsRead(api: ApiClient, upTo: string): Promise<UnreadNotifications> {
  return api.request('/v1/notifications/read', {
    method: 'POST',
    body: { upTo },
    schema: UnreadNotificationsSchema,
  });
}

/** `PUT /me/push-tokens` (6.4): liga o token deste aparelho à conta e à sessão. */
export function registerPushToken(
  api: ApiClient,
  expoToken: string,
  platform: PushPlatform,
): Promise<void> {
  return api.request('/v1/me/push-tokens', {
    method: 'PUT',
    body: { expoToken, platform },
    schema: NoContentSchema,
  });
}

/** `DELETE /me/push-tokens` com o token no corpo (nunca na URL). */
export function removePushToken(api: ApiClient, expoToken: string): Promise<void> {
  return api.request('/v1/me/push-tokens', {
    method: 'DELETE',
    body: { expoToken },
    schema: NoContentSchema,
  });
}
