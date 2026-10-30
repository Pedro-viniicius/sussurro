import type {
  Notification,
  NotificationActor,
  NotificationPost,
  NotificationsPage,
} from '@sussurro/shared';

import { uuid } from './post-fixtures';

/** Fixtures das notificações da Fase 6 (formato exato do `NotificationsPageSchema`). */

const MINUTE_MS = 60_000;

/** Instante ISO de `minutes` minutos atrás (relativo ao relógio do teste). */
export function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE_MS).toISOString();
}

/** Meio-dia de `days` dias de calendário atrás, no fuso do aparelho (A-35). */
export function daysAgo(days: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12).toISOString();
}

export function actor(overrides: Partial<NotificationActor> = {}): NotificationActor {
  return {
    handle: 'marinac',
    name: 'Marina Costa',
    avatarUrl: null,
    accountType: 'personal',
    profileVisible: true,
    ...overrides,
  };
}

export function notifiedPost(overrides: Partial<NotificationPost> = {}): NotificationPost {
  const id = uuid();
  return { id, type: 'photo', thumbUrl: `https://cdn.teste/media/${id}/thumb.jpg`, ...overrides };
}

interface Common {
  id?: string;
  read?: boolean;
  updatedAt?: string;
}

function base({ id = uuid(), read = false, updatedAt = minutesAgo(20) }: Common) {
  return { id, read, createdAt: updatedAt, updatedAt };
}

export function liked(
  options: Common & { actor?: NotificationActor; post?: NotificationPost } = {},
): Notification {
  return {
    ...base(options),
    type: 'post_liked',
    actor: options.actor ?? actor(),
    post: options.post ?? notifiedPost(),
  };
}

export function commented(
  options: Common & { actor?: NotificationActor; post?: NotificationPost; excerpt?: string } = {},
): Notification {
  return {
    ...base(options),
    type: 'post_commented',
    actor: options.actor ?? actor({ handle: 'lucasf', name: 'Lucas Ferreira' }),
    post: options.post ?? notifiedPost(),
    excerpt: options.excerpt ?? 'Que luz bonita!',
  };
}

export function replied(
  options: Common & { actor?: NotificationActor; post?: NotificationPost; excerpt?: string } = {},
): Notification {
  return {
    ...base(options),
    type: 'comment_replied',
    actor: options.actor ?? actor({ handle: 'tomas.o', name: 'Tomás Oliveira' }),
    post: options.post ?? notifiedPost({ type: 'text', thumbUrl: null }),
    excerpt: options.excerpt ?? 'Combinado, levo a sobremesa.',
  };
}

export function connected(options: Common & { actor?: NotificationActor } = {}): Notification {
  return {
    ...base(options),
    type: 'connection_created',
    actor: options.actor ?? actor({ handle: 'caio.r', name: 'Caio Ribeiro' }),
  };
}

export function followers(count: number, options: Common = {}): Notification {
  return { ...base(options), type: 'new_followers', count };
}

export function notificationsPage(
  items: Notification[],
  nextCursor: string | null = null,
): NotificationsPage {
  return { items, nextCursor };
}
