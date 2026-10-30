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

/** Valores de uma consulta que falhou (fictícios; PERM-17). */
const DB_VALUES = {
  email: 'ana.souza+teste@exemplo.com.br',
  hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsLWZpY3RpY2lv$aGFzaC1maWN0aWNpby1kZS10ZXN0ZQ', // gitleaks:allow
  name: 'Ana Souza Fictícia',
  bio: 'bio com quebra\n    at frame-falso (bio.js:1:1)',
};

function leakedDbValues(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Object.entries({ ...DB_VALUES, bio: 'frame-falso', salt: 'c2FsLWZpY3RpY2lv' })
    .filter(([, secret]) => text.includes(secret))
    .map(([name]) => name);
}

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

  it('[PERM-17] scrubText: os params de uma consulta que falhou saem até o fim do texto', () => {
    const message =
      'Failed query: update "users" set "email" = $1, "password_hash" = $2 where "id" = $3\n' +
      `params: ${DB_VALUES.email},${DB_VALUES.hash},${DB_VALUES.bio}`;
    const scrubbed = scrubText(message);
    expect(scrubbed).toBe(
      'Failed query: update "users" set "email" = $1, "password_hash" = $2 where "id" = $3\n' +
        `params: ${TELEMETRY_REDACTED}`,
    );
    expect(leakedDbValues(scrubbed)).toEqual([]);
    // Já escapado (linha de log em JSON) e no começo do texto.
    expect(scrubText(`Failed query: select 1\\nparams: ${DB_VALUES.email}`)).toBe(
      `Failed query: select 1\\nparams: ${TELEMETRY_REDACTED}`,
    );
    expect(scrubText(`params: ${DB_VALUES.name}`)).toBe(`params: ${TELEMETRY_REDACTED}`);
  });

  it('[PERM-17] scrubText: e-mail solto vira [Filtered]; versão de pacote no caminho fica', () => {
    expect(scrubText(`login de ${DB_VALUES.email} falhou`)).toBe(
      `login de ${TELEMETRY_REDACTED} falhou`,
    );
    expect(scrubText('Key (email)=(Joao.Silva@Exemplo.COM) already exists')).toBe(
      `Key (email)=(${TELEMETRY_REDACTED}) already exists`,
    );
    expect(scrubText('contato: joão@exemplo.com.br.')).toBe(`contato: ${TELEMETRY_REDACTED}.`);
    const frame = '    at f (/app/node_modules/.pnpm/drizzle-orm@0.45.4_x/node_modules/a.js:1:2)';
    expect(scrubText(frame)).toBe(frame);
  });

  it('[PERM-17] scrubText: hash argon2 vira [Filtered], inclusive as vírgulas dos parâmetros', () => {
    expect(scrubText(`hash=${DB_VALUES.hash} fim`)).toBe(`hash=${TELEMETRY_REDACTED} fim`);
    expect(scrubText('$argon2i$v=19$m=4096,t=3,p=1$c2Fs$aGFzaA')).toBe(TELEMETRY_REDACTED); // gitleaks:allow
    expect(leakedDbValues(scrubText(`a ${DB_VALUES.hash}`))).toEqual([]);
  });

  it('[PERM-17] scrubText: valor recusado pelo Postgres não sai', () => {
    expect(scrubText(`invalid input syntax for type uuid: "${DB_VALUES.name}"`)).toBe(
      `invalid input syntax for type uuid: "${TELEMETRY_REDACTED}"`,
    );
    expect(scrubText('invalid input value for enum account_type: "x"')).toBe(
      `invalid input value for enum account_type: "${TELEMETRY_REDACTED}"`,
    );
  });

  it('[PERM-17] evento com a mensagem de um DrizzleQueryError: e-mail, hash e nome não saem', () => {
    const message = `Failed query: insert into "users" values ($1, $2, $3)\nparams: ${DB_VALUES.email},${DB_VALUES.hash},${DB_VALUES.name}`;
    const event = {
      message,
      exception: {
        values: [
          { type: 'error', value: 'canceling statement due to statement timeout' },
          { type: 'Error', value: message },
        ],
      },
      breadcrumbs: [{ message: `query falhou: ${message}` }],
    };
    const scrubbed = scrubTelemetryEvent(event);
    expect(leakedDbValues(scrubbed)).toEqual([]);
    expect(scrubbed.exception.values[1]?.value).toBe(
      `Failed query: insert into "users" values ($1, $2, $3)\nparams: ${TELEMETRY_REDACTED}`,
    );
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
