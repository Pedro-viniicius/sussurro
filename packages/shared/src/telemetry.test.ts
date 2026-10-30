import { describe, expect, it } from 'vitest';

import { scrubTelemetryEvent, scrubText, stripQuery, TELEMETRY_REDACTED } from './telemetry.ts';

const SECRETS = {
  bearer: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2VncmVkby1kby1qd3Q',
  password: 'senha-super-secreta-42',
  refresh: 'refresh-opaco-de-256-bits',
  observed: 'AAECAwQFBgcICQoLDA0ODw',
  target: 'EBESExQVFhcYGRobHB0eHw',
  expo: 'ExponentPushToken[segredo-do-aparelho-123]',
  follower: '01a189e0-af57-7000-85fe-2054e618fea6',
  creator: '01a189e0-af57-7000-85fe-2054e618fea7',
  canary: 'canary_conn_abc123',
  cookie: 'sid=cookie-de-sessao',
  ip: '203.0.113.7',
};

function leaked(event: unknown): string[] {
  const text = JSON.stringify(event);
  return Object.entries(SECRETS)
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name);
}

describe('scrubTelemetryEvent (6.7, PERM-17)', () => {
  it('[PERM-17] CA1: Authorization, cookies, password, token, observedToken, targetToken e push token não saem', () => {
    const event = {
      message: `Falhou com Bearer ${SECRETS.bearer}`,
      user: { id: SECRETS.follower, ip_address: SECRETS.ip, email: 'ana@example.com' },
      request: {
        method: 'POST',
        url: `https://api.sussurro.app/v1/connections/requests?cursor=abc&token=${SECRETS.refresh}`,
        query_string: `token=${SECRETS.refresh}`,
        data: { password: SECRETS.password, observedToken: SECRETS.observed },
        cookies: { sid: SECRETS.cookie },
        env: { REMOTE_ADDR: SECRETS.ip },
        headers: {
          Authorization: `Bearer ${SECRETS.bearer}`,
          Cookie: SECRETS.cookie,
          'X-Forwarded-For': SECRETS.ip,
          'user-agent': 'okhttp',
        },
      },
      extra: {
        body: {
          password: SECRETS.password,
          refreshToken: SECRETS.refresh,
          observedToken: SECRETS.observed,
          targetToken: SECRETS.target,
          expoToken: SECRETS.expo,
        },
        note: `token do aparelho: ${SECRETS.expo}`,
      },
      breadcrumbs: [
        {
          message: `GET /v1/feed?cursor=${SECRETS.refresh}`,
          data: {
            url: `https://exp.host/push?token=${SECRETS.refresh}`,
            'http.query': `cursor=${SECRETS.refresh}`,
          },
        },
      ],
      exception: {
        values: [
          {
            type: 'Error',
            value: `Key (expo_token)=(${SECRETS.expo}) already exists`,
            stacktrace: { frames: [{ vars: { password: SECRETS.password } }] },
          },
        ],
      },
    };
    const scrubbed = scrubTelemetryEvent(event);
    expect(leaked(scrubbed)).toEqual([]);
    expect(scrubbed).not.toHaveProperty('user');
    expect(scrubbed.request).toEqual({
      method: 'POST',
      url: 'https://api.sussurro.app/v1/connections/requests',
      headers: { 'user-agent': 'okhttp' },
    });
    expect(scrubbed.extra.body).toEqual({
      password: TELEMETRY_REDACTED,
      refreshToken: TELEMETRY_REDACTED,
      observedToken: TELEMETRY_REDACTED,
      targetToken: TELEMETRY_REDACTED,
      expoToken: TELEMETRY_REDACTED,
    });
    expect(scrubbed.exception.values[0]?.value).toBe(
      `Key (expo_token)=(${TELEMETRY_REDACTED}) already exists`,
    );
  });

  it('CA2: listas e ids de relacionamento somem (seguidores, conexões, bloqueios, pares)', () => {
    const event = {
      extra: {
        followerId: SECRETS.follower,
        creatorId: SECRETS.creator,
        connections: [{ handle: SECRETS.canary }],
        page: { items: [{ handle: SECRETS.canary, name: 'Canário' }], nextCursor: null },
        pair: { userAId: SECRETS.follower, userBId: SECRETS.creator },
        request: { fromId: SECRETS.follower, toId: SECRETS.creator, status: 'pending' },
        notification: {
          actorId: SECRETS.follower,
          recipientId: SECRETS.creator,
          type: 'post_liked',
        },
      },
      contexts: { relations: { blockedBy: [SECRETS.follower], following: [SECRETS.creator] } },
      exception: {
        values: [
          { value: `Key (follower_id, creator_id)=(${SECRETS.follower}, ${SECRETS.creator})` },
        ],
      },
    };
    const scrubbed = scrubTelemetryEvent(event);
    expect(leaked(scrubbed)).toEqual([]);
    expect(scrubbed.extra).toEqual({
      page: { items: TELEMETRY_REDACTED, nextCursor: null },
      pair: {},
      request: { status: 'pending' },
      notification: { type: 'post_liked' },
    });
    expect(scrubbed.contexts).toEqual({ relations: {} });
  });

  it('mantém o que ajuda a investigar: tipo, rota, status, stack e ids de post', () => {
    const event = {
      transaction: 'GET /v1/posts/:id',
      tags: { route: '/v1/posts/:id', status: 500 },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'x is undefined',
            stacktrace: { frames: [{ function: 'f', lineno: 3 }] },
          },
        ],
      },
      extra: { postId: SECRETS.follower },
    };
    expect(scrubTelemetryEvent(event)).toEqual(event);
  });

  it('ciclos e profundidade não quebram a limpeza', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    const scrubbed = scrubTelemetryEvent({ extra: { cyclic } });
    expect(scrubbed.extra.cyclic).toEqual({ name: 'a', self: TELEMETRY_REDACTED });
  });

  it('texto e URL', () => {
    expect(scrubText(`a ${SECRETS.expo} b`)).toBe(`a ${TELEMETRY_REDACTED} b`);
    expect(scrubText('?password=1&x=2')).toBe(`?password=${TELEMETRY_REDACTED}&x=2`);
    expect(stripQuery('/v1/feed?type=photo#x')).toBe('/v1/feed');
    expect(stripQuery('/v1/feed')).toBe('/v1/feed');
  });

  it('span do tracing: URL sem query, query string fora, rota e método mantidos', () => {
    const span = {
      name: 'GET /v1/notifications',
      attributes: {
        'url.full': `https://api.sussurro.app/v1/notifications?cursor=${SECRETS.refresh}`,
        'url.query': `cursor=${SECRETS.refresh}`,
        'http.target': `/v1/notifications?cursor=${SECRETS.refresh}`,
        'http.route': '/v1/notifications',
        'http.request.method': 'GET',
        'enduser.id': SECRETS.follower,
        recipientId: SECRETS.follower,
      },
    };
    const scrubbed = scrubTelemetryEvent(span);
    expect(leaked(scrubbed)).toEqual([]);
    expect(scrubbed.attributes).toEqual({
      'url.full': 'https://api.sussurro.app/v1/notifications',
      'url.query': TELEMETRY_REDACTED,
      'http.target': '/v1/notifications',
      'http.route': '/v1/notifications',
      'http.request.method': 'GET',
    });
  });
});
