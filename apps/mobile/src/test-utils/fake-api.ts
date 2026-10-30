import type { AuthSession, Me, TokenPair } from '@sussurro/shared';

import type { FetchLike, HttpResponse } from '../lib/api/client';

export const BASE_URL = 'http://api.teste';

export interface FakeReply {
  status: number;
  body?: unknown;
}

export interface FakeCall {
  key: string;
  body: unknown;
  headers: Record<string, string>;
  /** Query string decodificada (ex.: `{ type: 'photo', cursor: 'c2' }`). */
  query: Record<string, string>;
}

function parseQuery(url: string): Record<string, string> {
  const search = url.split('?')[1] ?? '';
  const query: Record<string, string> = {};
  for (const pair of search.split('&')) {
    if (pair === '') continue;
    const [name = '', value = ''] = pair.split('=');
    query[decodeURIComponent(name)] = decodeURIComponent(value);
  }
  return query;
}

type Handler = (call: FakeCall) => FakeReply | Promise<FakeReply>;

/**
 * API falsa para os testes do app: cada rota (`'POST /v1/auth/login'`) tem uma resposta ou uma
 * função. Rota sem resposta → 404, para o teste falhar alto.
 */
export function createFakeApi() {
  const handlers = new Map<string, Handler>();
  const calls: FakeCall[] = [];

  const fetch: FetchLike = async (url, init) => {
    const path = url.slice(BASE_URL.length).split('?')[0] ?? '';
    const key = `${init.method} ${path}`;
    const call: FakeCall = {
      key,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
      headers: init.headers,
      query: parseQuery(url),
    };
    calls.push(call);
    const handler = handlers.get(key);
    const reply =
      handler === undefined
        ? { status: 404, body: { code: 'NOT_FOUND', message: `sem resposta para ${key}` } }
        : await handler(call);
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    const response: HttpResponse = {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: () => Promise.resolve(text),
    };
    return response;
  };

  return {
    fetch,
    calls,
    on(key: string, reply: FakeReply | Handler) {
      handlers.set(key, typeof reply === 'function' ? reply : () => reply);
    },
    callsTo(key: string): FakeCall[] {
      return calls.filter((call) => call.key === key);
    },
  };
}

export type FakeApi = ReturnType<typeof createFakeApi>;

let tokenSequence = 0;

export function tokenPair(): TokenPair {
  tokenSequence += 1;
  return {
    accessToken: `access-${String(tokenSequence)}`,
    accessTokenExpiresAt: '2026-10-29T12:15:00.000Z',
    refreshToken: `refresh-${String(tokenSequence)}`,
    refreshTokenExpiresAt: '2026-11-28T12:00:00.000Z',
  };
}

const ownFields = {
  id: '01a189e0-af57-7000-85fe-2054e618fea6',
  createdAt: '2026-10-29T12:00:00.000Z',
  avatarUrl: null,
};

export function personalMe(overrides: Partial<Extract<Me, { accountType: 'personal' }>> = {}): Me {
  return {
    ...ownFields,
    email: 'helena@example.com',
    emailVerified: true,
    handle: 'helena',
    name: 'Helena Souza',
    bio: 'Arquiteta. Café coado, caminhadas longas e livros usados.',
    accountType: 'personal',
    counts: { posts: 5, connections: 4, creators: 3 },
    ...overrides,
  };
}

export function creatorMe(overrides: Partial<Extract<Me, { accountType: 'creator' }>> = {}): Me {
  return {
    ...ownFields,
    id: '01a189e0-af57-7000-85fe-2054e618fea7',
    email: 'bia@example.com',
    emailVerified: true,
    handle: 'cozinhadabia',
    name: 'Beatriz Lemos',
    bio: 'Receitas de casa, sem pressa.',
    accountType: 'creator',
    counts: { posts: 6, followers: 2418 },
    ...overrides,
  };
}

export function session(user: Me): AuthSession {
  return { user, tokens: tokenPair() };
}
