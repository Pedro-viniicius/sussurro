import { z } from 'zod';

import {
  CommentAuthorSchema,
  CursorSchema,
  PageLimitSchema,
  type PostType,
  PostTypeSchema,
} from './posts.ts';
import { normalizeText } from './text.ts';
import type { AccountType } from './users.ts';

// Notificações no app, seguidores agregados e anônimos e push (ADR 0011; histórias 6.1 a 6.6).

const uuid = z.uuid({ error: 'Identificador inválido.' });
const isoDate = z.iso.datetime();

// --- tipos e prazos ------------------------------------------------------------------------------

/** Tipos da v1 (ADR 0011). Sem agregação de curtidas na v1: uma por pessoa e post. */
export const NOTIFICATION_TYPES = [
  'post_liked',
  'post_commented',
  'comment_replied',
  'new_followers',
  'connection_created',
] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/** A lista (`GET /notifications`) mostra só os últimos 30 dias (arquitetura.md §12). */
export const NOTIFICATIONS_LIST_DAYS = 30;
/** Retenção no banco: o job do worker apaga o que passou de 90 dias sem atualização (ADR 0011). */
export const NOTIFICATIONS_RETENTION_DAYS = 90;
/** Trecho do comentário na notificação do app (o push nunca leva o comentário, NOT-08). */
export const NOTIFICATION_EXCERPT_MAX_CHARS = 80;
/** O contador do ponto azul para em 99 (99 = "99 ou mais"). */
export const UNREAD_COUNT_MAX = 99;
/**
 * Fuso do "dia" dos seguidores agregados (ADR 0011, NOT-03): a virada às 00:00 de Brasília abre
 * uma linha nova. O agrupamento "Hoje"/"Esta semana" do app usa o fuso do aparelho (A-35).
 */
export const FOLLOWERS_BUCKET_TIME_ZONE = 'America/Sao_Paulo';
/** Push tokens ativos por conta: o mais antigo sai quando chega um novo além deste limite. */
export const MAX_PUSH_TOKENS_PER_ACCOUNT = 10;

// --- resposta de GET /notifications --------------------------------------------------------------

/**
 * Quem fez a ação (curtiu, comentou, respondeu, se conectou). `profileVisible` diz se o @ é tocável
 * (D11/A-07), como no autor de um comentário. Nunca existe nas notificações de seguidores.
 */
export const NotificationActorSchema = CommentAuthorSchema;
export type NotificationActor = z.infer<typeof NotificationActorSchema>;

/** O post da notificação, com a miniatura (foto: a primeira; reel: o poster; texto: `null`). */
export const NotificationPostSchema = z.object({
  id: uuid,
  type: PostTypeSchema,
  thumbUrl: z.url().nullable(),
});
export type NotificationPost = z.infer<typeof NotificationPostSchema>;

const base = {
  id: uuid,
  /** `false` até `POST /notifications/read` com `upTo` igual ou depois de `updatedAt`. */
  read: z.boolean(),
  createdAt: isoDate,
  /** Ordem da lista e base do agrupamento "Hoje"/"Esta semana" (`groupNotifications`). */
  updatedAt: isoDate,
};

/**
 * Uma notificação, vista só por quem a recebeu. A de seguidores (6.3) não tem `actor` nem `post`:
 * o schema nem aceita esses campos, e o interceptor da API descarta tudo o que não está aqui
 * (NOT-02). `count` só existe nela ("3 novas pessoas…", avatar "+3").
 */
export const NotificationSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('post_liked'),
    actor: NotificationActorSchema,
    post: NotificationPostSchema,
  }),
  z.object({
    ...base,
    type: z.literal('post_commented'),
    actor: NotificationActorSchema,
    post: NotificationPostSchema,
    /** Até 80 caracteres do comentário, numa linha (`notificationExcerpt`). */
    excerpt: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('comment_replied'),
    actor: NotificationActorSchema,
    post: NotificationPostSchema,
    excerpt: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('connection_created'),
    actor: NotificationActorSchema,
  }),
  z.object({
    ...base,
    type: z.literal('new_followers'),
    count: z.int().min(1),
  }),
]);
export type Notification = z.infer<typeof NotificationSchema>;

/**
 * `GET /notifications?cursor=&limit=`: as notificações de quem chama, da mais recente
 * (`updatedAt`) para a mais antiga, só dos últimos 30 dias. Parâmetro a mais → 400.
 */
export const NotificationsQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: PageLimitSchema,
});
export type NotificationsQuery = z.infer<typeof NotificationsQuerySchema>;

export const NotificationsPageSchema = z.object({
  items: z.array(NotificationSchema),
  /** `null` na última página. */
  nextCursor: CursorSchema.nullable(),
});
export type NotificationsPage = z.infer<typeof NotificationsPageSchema>;

/**
 * `GET /notifications/unread-count` (ponto azul do coração, 6.2) e resposta de
 * `POST /notifications/read`. Para em 99.
 */
export const UnreadNotificationsSchema = z.object({
  count: z.int().min(0).max(UNREAD_COUNT_MAX),
});
export type UnreadNotifications = z.infer<typeof UnreadNotificationsSchema>;

/**
 * `POST /notifications/read {upTo}`: marca como lidas as notificações com `updatedAt` até `upTo`
 * (o `updatedAt` da mais recente que o app mostrou). Uma notificação de seguidores que recebeu
 * gente nova depois disso continua não lida (NOT-06).
 */
export const MarkNotificationsReadRequestSchema = z.strictObject({
  upTo: z.iso.datetime({ offset: true, error: 'Use uma data ISO 8601.' }),
});
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequestSchema>;

// --- push tokens (história 6.4) ------------------------------------------------------------------

/** `ExponentPushToken[...]` (ou `ExpoPushToken[...]`), como o `expo-notifications` devolve. */
export const ExpoPushTokenSchema = z
  .string()
  .max(255, { error: 'Token de push inválido.' })
  .regex(/^Expo(nent)?PushToken\[[^\]\s]{1,200}\]$/, { error: 'Token de push inválido.' });

export const PushPlatformSchema = z.enum(['ios', 'android'], { error: 'Use "ios" ou "android".' });
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

/**
 * `PUT /me/push-tokens` (204): registra o token deste aparelho para a conta e a sessão de quem
 * chama. Repetir é idempotente. Um token ativo de outra conta não muda (6.4 CA3).
 */
export const RegisterPushTokenRequestSchema = z.strictObject({
  expoToken: ExpoPushTokenSchema,
  platform: PushPlatformSchema,
});
export type RegisterPushTokenRequest = z.infer<typeof RegisterPushTokenRequestSchema>;

/**
 * `DELETE /me/push-tokens` (204): o token vai no corpo, e não na URL, para nunca aparecer em log
 * de acesso nem no Sentry. Só apaga o token se for de quem chama; o de outra conta não muda.
 */
export const RemovePushTokenRequestSchema = z.strictObject({
  expoToken: ExpoPushTokenSchema,
});
export type RemovePushTokenRequest = z.infer<typeof RemovePushTokenRequestSchema>;

// --- fila `push` (API → worker) ------------------------------------------------------------------

/**
 * Mensagem da fila `push` (ADR 0011): só ids. O worker relê o banco na hora de enviar (a
 * notificação pode ter sumido, sido lida ou o autor ter bloqueado) e monta o texto curto.
 */
export const PushJobMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('notification'), notificationId: z.uuid() }),
  /** Pedido de conexão pendente (6.6): push para quem recebeu, com o Conectar no `url`. */
  z.strictObject({ type: z.literal('connection-request'), requestId: z.uuid() }),
]);
export type PushJobMessage = z.infer<typeof PushJobMessageSchema>;

// --- conteúdo do push (worker → Expo → APNs/FCM → app) -------------------------------------------

export const PUSH_KINDS = [...NOTIFICATION_TYPES, 'connection_request'] as const;
export const PushKindSchema = z.enum(PUSH_KINDS);
export type PushKind = z.infer<typeof PushKindSchema>;

/**
 * `data` do push, lido pelo app ao tocar na notificação: o tipo e a rota do Expo Router a abrir.
 * Sem ids de conta, de post ou de comentário e sem o texto de ninguém (minimização: o `data` passa
 * pelo Expo e pela Apple/Google).
 */
export const PushDataSchema = z.object({
  type: PushKindSchema,
  url: z.string().startsWith('/'),
});
export type PushData = z.infer<typeof PushDataSchema>;

/** Rota do app que o push abre (6.5 CA5, 6.6): Notificações da conta ou o Conectar. */
export function pushTargetUrl(kind: PushKind, accountType: AccountType): string {
  if (kind === 'connection_request') {
    return '/pessoal/conectar';
  }
  return accountType === 'creator' ? '/criador/notificacoes' : '/pessoal/inicio/notificacoes';
}

/** "sua foto", "seu texto", "seu reel". */
export function ownPostLabel(type: PostType): string {
  switch (type) {
    case 'photo':
      return 'sua foto';
    case 'text':
      return 'seu texto';
    case 'reel':
      return 'seu reel';
  }
}

/** "na sua foto", "no seu texto", "no seu reel". */
function onOwnPost(type: PostType): string {
  return type === 'photo' ? 'na sua foto' : `no ${ownPostLabel(type)}`;
}

/** NOT-05: "1 nova pessoa começou a seguir você." / "3 novas pessoas começaram a seguir você." */
export function followersText(count: number): string {
  return count === 1
    ? '1 nova pessoa começou a seguir você.'
    : `${String(count)} novas pessoas começaram a seguir você.`;
}

/** Avatar agregado da notificação de seguidores (p21): "+3"; acima de 99, "99+". */
export function followersBadge(count: number): string {
  return count > 99 ? '99+' : `+${String(count)}`;
}

/** O que o texto do push pode usar. Não há campo para o comentário: o push nunca o leva (NOT-08). */
export type PushTextInput =
  | { type: 'post_liked' | 'post_commented'; actorHandle: string; postType: PostType }
  | { type: 'comment_replied' | 'connection_created' | 'connection_request'; actorHandle: string }
  | { type: 'new_followers'; count: number };

/**
 * Texto curto do push (6.5 CA1 e CA2, 6.6): "lucasf comentou na sua foto." Seguidores, agregado e
 * sem ninguém nomeado.
 */
export function pushBody(input: PushTextInput): string {
  switch (input.type) {
    case 'post_liked':
      return `${input.actorHandle} curtiu ${ownPostLabel(input.postType)}.`;
    case 'post_commented':
      return `${input.actorHandle} comentou ${onOwnPost(input.postType)}.`;
    case 'comment_replied':
      return `${input.actorHandle} respondeu seu comentário.`;
    case 'connection_created':
      return `Você e ${input.actorHandle} estão conectados.`;
    case 'connection_request':
      return `${input.actorHandle} quer se conectar com você.`;
    case 'new_followers':
      return followersText(input.count);
  }
}

// --- texto da notificação no app (p09, p21) ------------------------------------------------------

/**
 * Um pedaço do texto: o @ (em 600, tocável quando `actor.profileVisible`), texto comum ou o trecho
 * do comentário entre aspas.
 */
export interface NotificationTextPart {
  kind: 'handle' | 'text' | 'quote';
  value: string;
}

/**
 * Texto de uma notificação no app, em pedaços: "marinac curtiu sua foto.", "lucasf comentou na sua
 * foto: “Que luz bonita!”", "tomas respondeu seu comentário: “…”", "Você e caio.r estão
 * conectados." e "3 novas pessoas começaram a seguir você.".
 */
export function notificationTextParts(notification: Notification): NotificationTextPart[] {
  switch (notification.type) {
    case 'post_liked':
      return [
        { kind: 'handle', value: notification.actor.handle },
        { kind: 'text', value: ` curtiu ${ownPostLabel(notification.post.type)}.` },
      ];
    case 'post_commented':
      return [
        { kind: 'handle', value: notification.actor.handle },
        { kind: 'text', value: ` comentou ${onOwnPost(notification.post.type)}: ` },
        { kind: 'quote', value: `“${notification.excerpt}”` },
      ];
    case 'comment_replied':
      return [
        { kind: 'handle', value: notification.actor.handle },
        { kind: 'text', value: ' respondeu seu comentário: ' },
        { kind: 'quote', value: `“${notification.excerpt}”` },
      ];
    case 'connection_created':
      return [
        { kind: 'text', value: 'Você e ' },
        { kind: 'handle', value: notification.actor.handle },
        { kind: 'text', value: ' estão conectados.' },
      ];
    case 'new_followers':
      return [{ kind: 'text', value: followersText(notification.count) }];
  }
}

/** O texto inteiro, para o rótulo de acessibilidade da linha. */
export function notificationPlainText(notification: Notification): string {
  return notificationTextParts(notification)
    .map((part) => part.value)
    .join('');
}

/**
 * Trecho de um comentário para a notificação: uma linha (quebras e espaços seguidos viram um
 * espaço) com até 80 code points, terminando em "…" quando cortado.
 */
export function notificationExcerpt(body: string): string {
  const oneLine = normalizeText(body).replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine);
  if (chars.length <= NOTIFICATION_EXCERPT_MAX_CHARS) {
    return oneLine;
  }
  return `${chars
    .slice(0, NOTIFICATION_EXCERPT_MAX_CHARS - 1)
    .join('')
    .trimEnd()}…`;
}

// --- dias e agrupamento "Hoje" / "Esta semana" ---------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Dia `YYYY-MM-DD` de um instante. Com `timeZone` (no servidor: America/Sao_Paulo), pelo
 * `Intl`; sem ele, pelo fuso do aparelho (getters locais do `Date`, sem depender do `Intl` do
 * Hermes).
 */
export function calendarDayKey(at: Date, timeZone?: string): string {
  if (timeZone === undefined) {
    return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: 'year' | 'month' | 'day') =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Chave do upsert dos seguidores (ADR 0011): `nf:` + o dia em America/Sao_Paulo. */
export function followersBucketKey(at: Date): string {
  return `nf:${calendarDayKey(at, FOLLOWERS_BUCKET_TIME_ZONE)}`;
}

/** Dias inteiros entre dois `YYYY-MM-DD` (`later - earlier`). */
function daysBetween(earlier: string, later: string): number {
  return Math.round(
    (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 864e5,
  );
}

export type NotificationSectionKey = 'today' | 'week' | 'earlier';

/** Títulos das seções da tela (p09, p21). "Anteriores": de 7 a 30 dias atrás. */
export const NOTIFICATION_SECTION_TITLES: Readonly<Record<NotificationSectionKey, string>> = {
  today: 'Hoje',
  week: 'Esta semana',
  earlier: 'Anteriores',
};

export interface NotificationSection<T> {
  key: NotificationSectionKey;
  title: string;
  items: T[];
}

/**
 * Agrupa a lista (já na ordem da API) em "Hoje" (mesmo dia de `now`), "Esta semana" (de 1 a 6 dias
 * antes) e "Anteriores" (o resto dos 30 dias), pelo `updatedAt` e pelo fuso do aparelho (A-35;
 * `timeZone` só nos testes). Seções vazias não aparecem.
 */
export function groupNotifications<T extends { updatedAt: string }>(
  items: readonly T[],
  now: Date,
  timeZone?: string,
): NotificationSection<T>[] {
  const today = calendarDayKey(now, timeZone);
  const sections = new Map<NotificationSectionKey, T[]>();
  for (const item of items) {
    const days = daysBetween(calendarDayKey(new Date(item.updatedAt), timeZone), today);
    const key: NotificationSectionKey = days <= 0 ? 'today' : days <= 6 ? 'week' : 'earlier';
    const list = sections.get(key) ?? [];
    list.push(item);
    sections.set(key, list);
  }
  return (['today', 'week', 'earlier'] as const).flatMap((key) => {
    const list = sections.get(key);
    return list === undefined
      ? []
      : [{ key, title: NOTIFICATION_SECTION_TITLES[key], items: list }];
  });
}
