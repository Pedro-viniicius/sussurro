import { type Database, sql } from '@sussurro/db';
import {
  type AccountType,
  type NotificationType,
  type PostType,
  type PushJobMessage,
  type PushKind,
  pushBody,
  pushTargetUrl,
} from '@sussurro/shared';

/** O que vai para os aparelhos de uma conta. Sem nada do conteúdo de ninguém além do @ (NOT-08). */
export interface PushContent {
  recipientId: string;
  kind: PushKind;
  body: string;
  url: string;
  priority: 'default' | 'high';
  ttlS?: number;
  collapseKey?: string;
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

interface NotificationPushRow {
  type: NotificationType;
  count: number;
  recipientId: string;
  recipientType: AccountType;
  actorHandle: string | null;
  postType: PostType | null;
  deliverable: boolean;
}

/**
 * Texto do push de uma notificação, relido do banco na hora de enviar. `null` (não envia) quando a
 * notificação sumiu, já foi lida, a conta de quem recebe ou de quem agiu foi excluída, há bloqueio
 * entre as duas, o post ou o comentário foi apagado (ou o post deixou de ser visível) ou a conexão
 * foi desfeita. O comentário nunca é lido aqui: o push não leva a íntegra (NOT-08).
 */
async function notificationContent(
  db: Database,
  notificationId: string,
): Promise<PushContent | null> {
  const [row] = rowsOf<NotificationPushRow>(
    await db.execute(sql`
      select n.type, n.count, n.recipient_id as "recipientId", r.account_type as "recipientType",
             a.handle as "actorHandle", p.type as "postType",
             (n.read_at is null
              and r.deleted_at is null
              and (n.actor_id is null or (
                    a.deleted_at is null
                    and not exists (
                      select 1 from blocks b
                       where (b.blocker_id = n.recipient_id and b.blocked_id = n.actor_id)
                          or (b.blocker_id = n.actor_id and b.blocked_id = n.recipient_id))))
              and (n.post_id is null or (
                    p.deleted_at is null and p.status = 'published' and pa.deleted_at is null
                    and (p.author_id = n.recipient_id or (
                          not exists (
                            select 1 from blocks b
                             where (b.blocker_id = n.recipient_id and b.blocked_id = p.author_id)
                                or (b.blocker_id = p.author_id and b.blocked_id = n.recipient_id))
                          and (pa.account_type = 'creator' or exists (
                            select 1 from connections pc
                             where (pc.user_a_id = n.recipient_id and pc.user_b_id = p.author_id)
                                or (pc.user_b_id = n.recipient_id and pc.user_a_id = p.author_id)))))))
              and (n.comment_id is null or c.deleted_at is null)
              and (n.type <> 'connection_created' or exists (
                    select 1 from connections cc
                     where (cc.user_a_id = n.recipient_id and cc.user_b_id = n.actor_id)
                        or (cc.user_b_id = n.recipient_id and cc.user_a_id = n.actor_id)))
             ) as deliverable
        from notifications n
        join users r on r.id = n.recipient_id
        left join users a on a.id = n.actor_id
        left join posts p on p.id = n.post_id
        left join users pa on pa.id = p.author_id
        left join comments c on c.id = n.comment_id
       where n.id = ${notificationId}::uuid`),
  );
  if (!row?.deliverable) {
    return null;
  }
  const base = {
    recipientId: row.recipientId,
    kind: row.type,
    url: pushTargetUrl(row.type, row.recipientType),
    priority: 'default' as const,
  };
  switch (row.type) {
    case 'new_followers':
      // Agregado e anônimo (6.5 CA2): só o número do dia; o push novo substitui o anterior.
      return {
        ...base,
        body: pushBody({ type: 'new_followers', count: row.count }),
        collapseKey: `nf-${notificationId}`,
      };
    case 'post_liked':
    case 'post_commented':
      return row.actorHandle === null || row.postType === null
        ? null
        : {
            ...base,
            body: pushBody({
              type: row.type,
              actorHandle: row.actorHandle,
              postType: row.postType,
            }),
          };
    case 'comment_replied':
    case 'connection_created':
      return row.actorHandle === null
        ? null
        : { ...base, body: pushBody({ type: row.type, actorHandle: row.actorHandle }) };
  }
}

interface RequestPushRow {
  toId: string;
  fromHandle: string;
  expiresAt: Date | string;
  deliverable: boolean;
}

/**
 * Push do pedido de conexão (6.6): só enquanto está pendente e dentro dos 120 s (o push vence junto,
 * pelo `ttl`), com as duas contas ativas e sem bloqueio. Abre o Conectar; o aceite continua exigindo
 * a tela aberta e o token observado.
 */
async function connectionRequestContent(
  db: Database,
  requestId: string,
  now: Date,
): Promise<PushContent | null> {
  const [row] = rowsOf<RequestPushRow>(
    await db.execute(sql`
      select r.to_id as "toId", f.handle as "fromHandle", r.expires_at as "expiresAt",
             (r.status = 'pending' and r.expires_at > ${now.toISOString()}::timestamptz
              and f.deleted_at is null and t.deleted_at is null
              and not exists (
                select 1 from blocks b
                 where (b.blocker_id = r.from_id and b.blocked_id = r.to_id)
                    or (b.blocker_id = r.to_id and b.blocked_id = r.from_id))) as deliverable
        from connection_requests r
        join users f on f.id = r.from_id
        join users t on t.id = r.to_id
       where r.id = ${requestId}::uuid`),
  );
  if (!row?.deliverable) {
    return null;
  }
  const remainingS = Math.ceil((new Date(row.expiresAt).getTime() - now.getTime()) / 1000);
  return {
    recipientId: row.toId,
    kind: 'connection_request',
    body: pushBody({ type: 'connection_request', actorHandle: row.fromHandle }),
    url: pushTargetUrl('connection_request', 'personal'),
    priority: 'high',
    ttlS: Math.max(1, remainingS),
  };
}

/** Conteúdo do push de uma mensagem da fila, ou `null` se não há mais o que enviar. */
export function loadPushContent(
  db: Database,
  job: PushJobMessage,
  now: Date,
): Promise<PushContent | null> {
  return job.type === 'notification'
    ? notificationContent(db, job.notificationId)
    : connectionRequestContent(db, job.requestId, now);
}

/**
 * Push tokens ativos da conta: não desativados (`DeviceNotRegistered`) e de uma sessão viva (a
 * família de refresh do aparelho não foi revogada nem venceu). Logout, sair de todos e exclusão de
 * conta já apagam os tokens; isto cobre a sessão que só venceu.
 */
export async function activePushTokens(
  db: Database,
  userId: string,
  now: Date,
): Promise<{ id: string; expoToken: string }[]> {
  return rowsOf<{ id: string; expoToken: string }>(
    await db.execute(sql`
      select pt.id, pt.expo_token as "expoToken"
        from push_tokens pt
       where pt.user_id = ${userId}::uuid
         and pt.disabled_at is null
         and exists (
           select 1 from refresh_tokens r
            where r.user_id = pt.user_id and r.family_id = pt.refresh_family_id
              and r.revoked_at is null and r.expires_at > ${now.toISOString()}::timestamptz)
       order by pt.last_seen_at desc`),
  );
}
