import { describe, expect, it, vi } from 'vitest';

import {
  AccessPolicyService,
  isConnectionRequestAllowed,
  isFollowAllowed,
  isPostVisible,
  isProfileVisible,
  type PostTarget,
  type Relationship,
} from './access-policy.service.js';
import type { RelationsRepository } from './relations.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';

const viewer: AuthContext = {
  userId: '01a189e0-af57-7000-85fe-2054e618fea6',
  accountType: 'personal',
  familyId: '01a189e0-af57-7000-85fe-2054e618fea7',
  emailVerified: true,
};
const creatorViewer: AuthContext = { ...viewer, accountType: 'creator' };
const OTHER = '01a189e0-af57-7000-85fe-2054e618fe00';

const NONE: Relationship = { connected: false, blocked: false };
const CONNECTED: Relationship = { connected: true, blocked: false };
const BLOCKED: Relationship = { connected: false, blocked: true };

function policyWith(options: { connected?: string[]; blocked?: string[] } = {}) {
  const connected = options.connected ?? [];
  const blocked = options.blocked ?? [];
  const relations = {
    relationship: vi.fn((_viewer: string, other: string) =>
      Promise.resolve({ connected: connected.includes(other), blocked: blocked.includes(other) }),
    ),
    connectedAmong: vi.fn((_viewer: string, others: readonly string[]) =>
      Promise.resolve(new Set(others.filter((id) => connected.includes(id)))),
    ),
    blockedAmong: vi.fn((_viewer: string, others: readonly string[]) =>
      Promise.resolve(new Set(others.filter((id) => blocked.includes(id)))),
    ),
    isFollowing: vi.fn(() => Promise.resolve(true)),
  };
  return {
    policy: new AccessPolicyService(relations as unknown as RelationsRepository),
    relations,
  };
}

function post(overrides: Partial<PostTarget> = {}): PostTarget {
  return {
    authorId: OTHER,
    authorType: 'personal',
    status: 'published',
    deletedAt: null,
    authorDeletedAt: null,
    ...overrides,
  };
}

describe('AccessPolicyService.canViewProfile', () => {
  it('[PERM-13] o dono vê o próprio perfil pessoal (sem consultar relações)', async () => {
    const { policy, relations } = policyWith();
    await expect(
      policy.canViewProfile(viewer, { id: viewer.userId, accountType: 'personal' }),
    ).resolves.toBe(true);
    expect(relations.relationship).not.toHaveBeenCalled();
  });

  it('[PERM-13] perfil pessoal: conexão vê; não conexão e criador não', async () => {
    const target = { id: OTHER, accountType: 'personal' as const };
    await expect(
      policyWith({ connected: [OTHER] }).policy.canViewProfile(viewer, target),
    ).resolves.toBe(true);
    await expect(policyWith().policy.canViewProfile(viewer, target)).resolves.toBe(false);
    await expect(policyWith().policy.canViewProfile(creatorViewer, target)).resolves.toBe(false);
  });

  it('perfil de criador é visível a qualquer conta autenticada', async () => {
    await expect(
      policyWith().policy.canViewProfile(viewer, { id: OTHER, accountType: 'creator' }),
    ).resolves.toBe(true);
  });

  it('[X.2] com bloqueio em qualquer sentido, nem conexão nem criador são visíveis', async () => {
    const { policy } = policyWith({ connected: [OTHER], blocked: [OTHER] });
    await expect(
      policy.canViewProfile(viewer, { id: OTHER, accountType: 'personal' }),
    ).resolves.toBe(false);
    await expect(
      policy.canViewProfile(viewer, { id: OTHER, accountType: 'creator' }),
    ).resolves.toBe(false);
    // A própria conta continua visível (não existe bloqueio de si mesmo).
    expect(isProfileVisible(viewer, { id: viewer.userId, accountType: 'personal' }, BLOCKED)).toBe(
      true,
    );
  });
});

describe('AccessPolicyService.canViewPost (PERM-14, MID-09)', () => {
  it('[PERM-14] post de pessoal: só o autor e as conexões', async () => {
    await expect(
      policyWith({ connected: [OTHER] }).policy.canViewPost(viewer, post()),
    ).resolves.toBe(true);
    await expect(policyWith().policy.canViewPost(viewer, post())).resolves.toBe(false);
    await expect(
      policyWith().policy.canViewPost(viewer, post({ authorId: viewer.userId })),
    ).resolves.toBe(true);
  });

  it('[PERM-14] post de criador: qualquer conta autenticada', async () => {
    await expect(
      policyWith().policy.canViewPost(viewer, post({ authorType: 'creator' })),
    ).resolves.toBe(true);
  });

  it('[X.2] post de quem tem bloqueio com o leitor: invisível, mesmo de criador ou conexão', async () => {
    const { policy } = policyWith({ connected: [OTHER], blocked: [OTHER] });
    await expect(policy.canViewPost(viewer, post())).resolves.toBe(false);
    await expect(policy.canViewPost(viewer, post({ authorType: 'creator' }))).resolves.toBe(false);
  });

  it('[MID-09] processing, failed e draft: só o autor', () => {
    for (const status of ['processing', 'failed', 'draft'] as const) {
      expect(isPostVisible(viewer, post({ status, authorType: 'creator' }), CONNECTED)).toBe(false);
      expect(isPostVisible(viewer, post({ status, authorId: viewer.userId }), NONE)).toBe(true);
    }
  });

  it('[CONTA-02] post excluído ou de conta excluída não é visível nem para o autor', async () => {
    const { policy, relations } = policyWith({ connected: [OTHER] });
    await expect(policy.canViewPost(viewer, post({ deletedAt: new Date() }))).resolves.toBe(false);
    await expect(
      policy.canViewPost(viewer, post({ authorDeletedAt: new Date(), authorType: 'creator' })),
    ).resolves.toBe(false);
    expect(
      isPostVisible(viewer, post({ authorId: viewer.userId, deletedAt: new Date() }), CONNECTED),
    ).toBe(false);
    expect(relations.relationship).not.toHaveBeenCalled();
  });
});

describe('seguir e pedir conexão (ADR 0008, X.2 CA2)', () => {
  const creator = { id: OTHER, accountType: 'creator' as const };
  const person = { id: OTHER, accountType: 'personal' as const };

  it('[PERM-01] [PERM-03] só pessoal segue criador; alvo pessoal ou criador seguindo → não', async () => {
    expect(isFollowAllowed(viewer, creator, NONE)).toBe(true);
    expect(isFollowAllowed(viewer, person, NONE)).toBe(false);
    expect(isFollowAllowed(creatorViewer, creator, NONE)).toBe(false);
    const { policy, relations } = policyWith();
    await expect(policy.canFollow(viewer, person)).resolves.toBe(false);
    expect(relations.relationship).not.toHaveBeenCalled();
    await expect(policy.canFollow(viewer, creator)).resolves.toBe(true);
  });

  it('[X.2] bloqueio em qualquer sentido impede seguir', async () => {
    expect(isFollowAllowed(viewer, creator, BLOCKED)).toBe(false);
    await expect(policyWith({ blocked: [OTHER] }).policy.canFollow(viewer, creator)).resolves.toBe(
      false,
    );
  });

  it('[X.2] pedido de conexão (Fase 4): só entre pessoais, nunca a si mesmo nem com bloqueio', async () => {
    expect(isConnectionRequestAllowed(viewer, person, NONE)).toBe(true);
    expect(isConnectionRequestAllowed(viewer, person, BLOCKED)).toBe(false);
    expect(isConnectionRequestAllowed(viewer, creator, NONE)).toBe(false);
    expect(isConnectionRequestAllowed(creatorViewer, person, NONE)).toBe(false);
    expect(
      isConnectionRequestAllowed(viewer, { id: viewer.userId, accountType: 'personal' }, NONE),
    ).toBe(false);
    await expect(
      policyWith({ blocked: [OTHER] }).policy.canRequestConnection(viewer, person),
    ).resolves.toBe(false);
    await expect(policyWith().policy.canRequestConnection(viewer, person)).resolves.toBe(true);
  });

  it('[PROX-19] [X.2] estado do pedido: permitido, já conectados ou negado (bloqueio, tipo, a si mesmo)', async () => {
    await expect(policyWith().policy.connectionRequestState(viewer, person)).resolves.toBe(
      'allowed',
    );
    await expect(
      policyWith({ connected: [OTHER] }).policy.connectionRequestState(viewer, person),
    ).resolves.toBe('connected');
    await expect(
      policyWith({ blocked: [OTHER] }).policy.connectionRequestState(viewer, person),
    ).resolves.toBe('denied');
    const { policy, relations } = policyWith();
    await expect(policy.connectionRequestState(viewer, creator)).resolves.toBe('denied');
    await expect(policy.connectionRequestState(creatorViewer, person)).resolves.toBe('denied');
    await expect(
      policy.connectionRequestState(viewer, { id: viewer.userId, accountType: 'personal' }),
    ).resolves.toBe('denied');
    // Tipo de conta e a própria conta decidem sem consultar o banco.
    expect(relations.relationship).not.toHaveBeenCalled();
  });

  it('isFollowing: criador nunca segue (sem consultar)', async () => {
    const { policy, relations } = policyWith();
    await expect(policy.isFollowing(creatorViewer, OTHER)).resolves.toBe(false);
    expect(relations.isFollowing).not.toHaveBeenCalled();
    await expect(policy.isFollowing(viewer, OTHER)).resolves.toBe(true);
  });
});

describe('AccessPolicyService.visibleProfiles (D11, PERM-10c, X.2)', () => {
  it('[PERM-10c] criador sempre; pessoal só o leitor e as conexões; nunca quem tem bloqueio', async () => {
    const connected = '01a189e0-af57-7000-85fe-2054e618fe01';
    const stranger = '01a189e0-af57-7000-85fe-2054e618fe02';
    const creator = '01a189e0-af57-7000-85fe-2054e618fe03';
    const blockedFriend = '01a189e0-af57-7000-85fe-2054e618fe04';
    const blockedCreator = '01a189e0-af57-7000-85fe-2054e618fe05';
    const { policy } = policyWith({
      connected: [connected, blockedFriend],
      blocked: [blockedFriend, blockedCreator],
    });
    const visible = await policy.visibleProfiles(viewer, [
      { id: viewer.userId, accountType: 'personal' },
      { id: connected, accountType: 'personal' },
      { id: stranger, accountType: 'personal' },
      { id: creator, accountType: 'creator' },
      { id: blockedFriend, accountType: 'personal' },
      { id: blockedCreator, accountType: 'creator' },
    ]);
    expect([...visible].sort()).toEqual([viewer.userId, connected, creator].sort());
    expect(isProfileVisible(viewer, { id: stranger, accountType: 'personal' }, NONE)).toBe(false);
  });
});
