import { describe, expect, it } from 'vitest';

import {
  calendarDayKey,
  ExpoPushTokenSchema,
  followersBadge,
  followersBucketKey,
  followersText,
  groupNotifications,
  MarkNotificationsReadRequestSchema,
  type Notification,
  notificationExcerpt,
  NotificationSchema,
  NotificationsQuerySchema,
  notificationPlainText,
  notificationTextParts,
  pushBody,
  PushDataSchema,
  PushJobMessageSchema,
  pushTargetUrl,
  RegisterPushTokenRequestSchema,
  RemovePushTokenRequestSchema,
} from './notifications.ts';

const actor = {
  handle: 'lucasf',
  name: 'Lucas',
  avatarUrl: null,
  accountType: 'personal' as const,
  profileVisible: true,
};
const post = { id: '01a189e0-af57-7000-85fe-2054e618fea6', type: 'photo' as const, thumbUrl: null };
const base = {
  id: '01a189e0-af57-7000-85fe-2054e618fea7',
  read: false,
  createdAt: '2026-10-30T12:00:00.000Z',
  updatedAt: '2026-10-30T12:00:00.000Z',
};

describe('textos das notificações (p09, p21)', () => {
  it('[NOT-05] seguidores: singular com 1, plural com N, avatar "+N"', () => {
    expect(followersText(1)).toBe('1 nova pessoa começou a seguir você.');
    expect(followersText(3)).toBe('3 novas pessoas começaram a seguir você.');
    expect(followersBadge(1)).toBe('+1');
    expect(followersBadge(3)).toBe('+3');
    expect(followersBadge(99)).toBe('+99');
    expect(followersBadge(1234)).toBe('99+');
  });

  it('curtida, comentário, resposta, conexão e seguidores no app', () => {
    const liked: Notification = { ...base, type: 'post_liked', actor, post };
    expect(notificationPlainText(liked)).toBe('lucasf curtiu sua foto.');
    expect(notificationTextParts(liked)[0]).toEqual({ kind: 'handle', value: 'lucasf' });
    expect(notificationPlainText({ ...liked, post: { ...post, type: 'text' } })).toBe(
      'lucasf curtiu seu texto.',
    );
    const commented: Notification = {
      ...base,
      type: 'post_commented',
      actor,
      post: { ...post, type: 'reel' },
      excerpt: 'Preciso aprender essa dobra.',
    };
    expect(notificationPlainText(commented)).toBe(
      'lucasf comentou no seu reel: “Preciso aprender essa dobra.”',
    );
    expect(notificationTextParts(commented).at(-1)).toEqual({
      kind: 'quote',
      value: '“Preciso aprender essa dobra.”',
    });
    expect(
      notificationPlainText({
        ...base,
        type: 'comment_replied',
        actor,
        post,
        excerpt: 'Combinado.',
      }),
    ).toBe('lucasf respondeu seu comentário: “Combinado.”');
    expect(notificationPlainText({ ...base, type: 'connection_created', actor })).toBe(
      'Você e lucasf estão conectados.',
    );
    expect(notificationPlainText({ ...base, type: 'new_followers', count: 2 })).toBe(
      '2 novas pessoas começaram a seguir você.',
    );
  });

  it('[NOT-05] (controle) pedaços de curtida, comentário, resposta e conexão: o @ em `handle`, sem `count` (só os seguidores têm o pedaço `count`)', () => {
    expect(notificationTextParts({ ...base, type: 'post_liked', actor, post })).toEqual([
      { kind: 'handle', value: 'lucasf' },
      { kind: 'text', value: ' curtiu sua foto.' },
    ]);
    expect(
      notificationTextParts({ ...base, type: 'post_commented', actor, post, excerpt: 'Oi' }),
    ).toEqual([
      { kind: 'handle', value: 'lucasf' },
      { kind: 'text', value: ' comentou na sua foto: ' },
      { kind: 'quote', value: '“Oi”' },
    ]);
    expect(
      notificationTextParts({ ...base, type: 'comment_replied', actor, post, excerpt: 'Oi' }),
    ).toEqual([
      { kind: 'handle', value: 'lucasf' },
      { kind: 'text', value: ' respondeu seu comentário: ' },
      { kind: 'quote', value: '“Oi”' },
    ]);
    expect(notificationTextParts({ ...base, type: 'connection_created', actor })).toEqual([
      { kind: 'text', value: 'Você e ' },
      { kind: 'handle', value: 'lucasf' },
      { kind: 'text', value: ' estão conectados.' },
    ]);
  });

  it('[NOT-05] seguidores (p21): "N novas pessoas" no pedaço `count`, sem @; juntos, os pedaços dão o texto do push', () => {
    expect(notificationTextParts({ ...base, type: 'new_followers', count: 1 })).toEqual([
      { kind: 'count', value: '1 nova pessoa' },
      { kind: 'text', value: ' começou a seguir você.' },
    ]);
    expect(notificationTextParts({ ...base, type: 'new_followers', count: 3 })).toEqual([
      { kind: 'count', value: '3 novas pessoas' },
      { kind: 'text', value: ' começaram a seguir você.' },
    ]);
    for (const count of [1, 2, 99, 100, 1234]) {
      const notification: Notification = { ...base, type: 'new_followers', count };
      const parts = notificationTextParts(notification);
      // Ninguém nomeado: nenhum pedaço é um @ (6.3, NOT-02).
      expect(parts.map((part) => part.kind)).toEqual(['count', 'text']);
      expect(notificationPlainText(notification)).toBe(followersText(count));
      expect(notificationPlainText(notification)).toBe(pushBody({ type: 'new_followers', count }));
    }
  });

  it('trecho do comentário: uma linha, até 80 caracteres, com "…" quando cortado', () => {
    expect(notificationExcerpt('  Que luz\n\nbonita!  ')).toBe('Que luz bonita!');
    const long = 'a'.repeat(200);
    const excerpt = notificationExcerpt(long);
    expect(Array.from(excerpt)).toHaveLength(80);
    expect(excerpt.endsWith('…')).toBe(true);
    // Emoji conta 1 (code points, A-09).
    expect(Array.from(notificationExcerpt('😀'.repeat(100)))).toHaveLength(80);
  });
});

describe('texto do push (6.5, 6.6)', () => {
  it('[NOT-08] curto e sem a íntegra do comentário (não há campo para ela)', () => {
    expect(pushBody({ type: 'post_commented', actorHandle: 'lucasf', postType: 'photo' })).toBe(
      'lucasf comentou na sua foto.',
    );
    expect(pushBody({ type: 'post_commented', actorHandle: 'lucasf', postType: 'reel' })).toBe(
      'lucasf comentou no seu reel.',
    );
    expect(pushBody({ type: 'post_liked', actorHandle: 'marinac', postType: 'text' })).toBe(
      'marinac curtiu seu texto.',
    );
    expect(pushBody({ type: 'comment_replied', actorHandle: 'tomas' })).toBe(
      'tomas respondeu seu comentário.',
    );
    expect(pushBody({ type: 'connection_created', actorHandle: 'caio.r' })).toBe(
      'Você e caio.r estão conectados.',
    );
    expect(pushBody({ type: 'connection_request', actorHandle: 'caio.r' })).toBe(
      'caio.r quer se conectar com você.',
    );
  });

  it('[NOT-08] seguidores: agregado e anônimo', () => {
    expect(pushBody({ type: 'new_followers', count: 1 })).toBe(
      '1 nova pessoa começou a seguir você.',
    );
    expect(pushBody({ type: 'new_followers', count: 5 })).toBe(
      '5 novas pessoas começaram a seguir você.',
    );
  });

  it('rota aberta pelo push: Notificações da conta ou o Conectar (6.6)', () => {
    expect(pushTargetUrl('post_liked', 'personal')).toBe('/pessoal/inicio/notificacoes');
    expect(pushTargetUrl('new_followers', 'creator')).toBe('/criador/notificacoes');
    expect(pushTargetUrl('connection_request', 'personal')).toBe('/pessoal/conectar');
    expect(PushDataSchema.parse({ type: 'connection_request', url: '/pessoal/conectar' })).toEqual({
      type: 'connection_request',
      url: '/pessoal/conectar',
    });
  });

  it('mensagem da fila push: só ids, campo a mais recusado', () => {
    const id = '01a189e0-af57-7000-85fe-2054e618fea6';
    expect(PushJobMessageSchema.parse({ type: 'notification', notificationId: id })).toEqual({
      type: 'notification',
      notificationId: id,
    });
    expect(
      PushJobMessageSchema.safeParse({ type: 'notification', notificationId: id, body: 'x' })
        .success,
    ).toBe(false);
    expect(
      PushJobMessageSchema.safeParse({ type: 'connection-request', requestId: 'x' }).success,
    ).toBe(false);
  });
});

describe('dias e agrupamento (NOT-03, A-35)', () => {
  it('[NOT-03] bucket dos seguidores pelo dia de America/Sao_Paulo', () => {
    // 23:59 e 00:01 de Brasília (UTC-3) caem em dias diferentes.
    expect(followersBucketKey(new Date('2026-10-31T02:59:00.000Z'))).toBe('nf:2026-10-30');
    expect(followersBucketKey(new Date('2026-10-31T03:01:00.000Z'))).toBe('nf:2026-10-31');
    expect(calendarDayKey(new Date('2026-10-31T02:59:00.000Z'), 'UTC')).toBe('2026-10-31');
  });

  it('"Hoje", "Esta semana" e "Anteriores" pelo fuso informado, sem seções vazias', () => {
    const now = new Date('2026-10-30T15:00:00.000Z');
    const at = (iso: string) => ({ id: iso, updatedAt: iso });
    const items = [
      at('2026-10-30T12:00:00.000Z'),
      at('2026-10-30T03:30:00.000Z'),
      at('2026-10-30T02:30:00.000Z'),
      at('2026-10-24T12:00:00.000Z'),
      at('2026-10-20T12:00:00.000Z'),
    ];
    const sections = groupNotifications(items, now, 'America/Sao_Paulo');
    expect(
      sections.map((section) => [section.title, section.items.map((item) => item.id)]),
    ).toEqual([
      ['Hoje', ['2026-10-30T12:00:00.000Z', '2026-10-30T03:30:00.000Z']],
      ['Esta semana', ['2026-10-30T02:30:00.000Z', '2026-10-24T12:00:00.000Z']],
      ['Anteriores', ['2026-10-20T12:00:00.000Z']],
    ]);
    expect(groupNotifications([], now, 'UTC')).toEqual([]);
    expect(groupNotifications([at('2026-10-30T01:00:00.000Z')], now, 'UTC')[0]?.title).toBe('Hoje');
  });
});

describe('contratos de entrada', () => {
  it('push token: só o formato do Expo, plataforma ios/android, nada a mais', () => {
    const token = 'ExponentPushToken[AbCdEf0123456789xyz_-]';
    expect(RegisterPushTokenRequestSchema.parse({ expoToken: token, platform: 'ios' })).toEqual({
      expoToken: token,
      platform: 'ios',
    });
    expect(ExpoPushTokenSchema.safeParse('ExpoPushToken[abc]').success).toBe(true);
    for (const bad of [
      '',
      'abc',
      'ExponentPushToken[]',
      'ExponentPushToken[a b]',
      'x'.repeat(300),
    ]) {
      expect(ExpoPushTokenSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(
      RegisterPushTokenRequestSchema.safeParse({ expoToken: token, platform: 'web' }).success,
    ).toBe(false);
    expect(
      RegisterPushTokenRequestSchema.safeParse({ expoToken: token, platform: 'ios', userId: 'x' })
        .success,
    ).toBe(false);
    expect(RemovePushTokenRequestSchema.safeParse({ expoToken: token }).success).toBe(true);
  });

  it('lista, leitura e o schema de seguidores sem ator', () => {
    expect(NotificationsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(NotificationsQuerySchema.safeParse({ userId: 'x' }).success).toBe(false);
    expect(MarkNotificationsReadRequestSchema.safeParse({ upTo: 'ontem' }).success).toBe(false);
    expect(
      MarkNotificationsReadRequestSchema.safeParse({ upTo: '2026-10-30T12:00:00-03:00' }).success,
    ).toBe(true);
    // [NOT-02] Os campos de quem seguiu não passam pelo schema da notificação de seguidores.
    const parsed = NotificationSchema.parse({
      ...base,
      type: 'new_followers',
      count: 3,
      actor,
      followerIds: ['x'],
    });
    expect(parsed).toEqual({ ...base, type: 'new_followers', count: 3 });
  });
});
