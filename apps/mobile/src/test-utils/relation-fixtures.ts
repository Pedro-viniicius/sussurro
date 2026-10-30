import type {
  BlockedAccount,
  CreatorSearchItem,
  OwnListItem,
  PublicProfile,
} from '@sussurro/shared';
import { act } from 'expo-router/testing-library';

import type { FakeReply } from './fake-api';

/** Fixtures da Fase 3 nos testes do app (formato exato dos schemas de packages/shared). */

export function searchItem(overrides: Partial<CreatorSearchItem> = {}): CreatorSearchItem {
  return {
    handle: 'estudioaurora',
    name: 'Estúdio Aurora',
    avatarUrl: null,
    followersCount: 5067,
    followedByMe: false,
    ...overrides,
  };
}

export function creatorProfile(
  overrides: Partial<Extract<PublicProfile, { accountType: 'creator' }>> = {},
): PublicProfile {
  return {
    handle: 'trilhasdosul',
    name: 'Rafael Duarte',
    bio: 'Trilhas e acampamentos no Sul do Brasil.',
    avatarUrl: null,
    accountType: 'creator',
    counts: { posts: 5, followers: 8903 },
    followedByMe: false,
    ...overrides,
  };
}

export function ownListItem(overrides: Partial<OwnListItem> = {}): OwnListItem {
  return {
    handle: 'caio.r',
    name: 'Caio Ribeiro',
    avatarUrl: null,
    since: '2026-10-27T15:00:00.000Z',
    ...overrides,
  };
}

export function blockedAccount(overrides: Partial<BlockedAccount> = {}): BlockedAccount {
  return { handle: 'caio.r', blockedAt: '2026-10-27T15:00:00.000Z', ...overrides };
}

/** Resposta da API falsa que só chega quando o teste mandar (para ver o estado otimista). */
export function deferredReply() {
  let resolve: (reply: FakeReply) => void = () => undefined;
  const promise = new Promise<FakeReply>((done) => {
    resolve = done;
  });
  return {
    handler: () => promise,
    resolve: async (reply: FakeReply) => {
      await act(async () => {
        resolve(reply);
        await promise;
      });
    },
  };
}

/** Chama o `onEndReached` de uma lista (o teste não rola a tela de verdade). */
export async function scrollListToEnd(list: { props: Record<string, unknown> }) {
  await act(async () => {
    (list.props.onEndReached as (info: { distanceFromEnd: number }) => void)({
      distanceFromEnd: 0,
    });
    await Promise.resolve();
  });
}

export const NOT_FOUND: FakeReply = {
  status: 404,
  body: { code: 'NOT_FOUND', message: 'Not found' },
};

export const RATE_LIMITED: FakeReply = {
  status: 429,
  body: { code: 'RATE_LIMITED', message: 'Too many requests' },
};
