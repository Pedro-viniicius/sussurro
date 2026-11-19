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
import { FakeClock } from '../../testing/fake-clock.js';
import type { ConnectionsRepository } from '../connections/connections.repository.js';

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

/**
 * `blocked`: contas com bloqueio com o leitor; para o `hasBlocked`, foram elas que bloquearam o
 * leitor. `iBlocked`: contas que o leitor bloqueou (o sentido da R1-PO-1); a relação também as dá
 * como bloqueadas.
 */
function policyWith(
  options: {
    connected?: string[];
    blocked?: string[];
    iBlocked?: string[];
    /** Contas com pedido de conexão com o leitor (qualquer direção), com o `created_at`. */
    requests?: Record<string, Date>;
  } = {},
) {
  const requests = options.requests ?? {};
  const connected = options.connected ?? [];
  const blocked = options.blocked ?? [];
  const iBlocked = options.iBlocked ?? [];
  const relations = {
    relationship: vi.fn((_viewer: string, other: string) =>
      Promise.resolve({
        connected: connected.includes(other),
        blocked: blocked.includes(other) || iBlocked.includes(other),
      }),
    ),
    hasBlocked: vi.fn((blockerId: string, blockedId: string) =>
      Promise.resolve(
        blockerId === viewer.userId
          ? iBlocked.includes(blockedId)
          : blockedId === viewer.userId && blocked.includes(blockerId),
      ),
    ),
    connectedAmong: vi.fn((_viewer: string, others: readonly string[]) =>
      Promise.resolve(new Set(others.filter((id) => connected.includes(id)))),
    ),
    blockedAmong: vi.fn((_viewer: string, others: readonly string[]) =>
      Promise.resolve(new Set(others.filter((id) => blocked.includes(id)))),
    ),
    isFollowing: vi.fn(() => Promise.resolve(true)),
  };
  const connections = {
    hasRecentRequestBetween: vi.fn((first: string, second: string, since: Date) => {
      const other = first === viewer.userId ? second : first;
      const createdAt = requests[other];
      return Promise.resolve(createdAt !== undefined && createdAt.getTime() > since.getTime());
    }),
  };
  const clock = new FakeClock();
  return {
    policy: new AccessPolicyService(
      relations as unknown as RelationsRepository,
      connections as unknown as ConnectionsRepository,
      clock,
    ),
    relations,
    connections,
    clock,
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

describe('bloquear e denunciar pelo @ (ADR 0013: sem o caminho do cartão do encosto)', () => {
  const person = { id: OTHER, accountType: 'personal' as const };
  const creator = { id: OTHER, accountType: 'creator' as const };
  const self = { id: viewer.userId, accountType: 'personal' as const };

  it('[PROX-61] canBlockOrReport: só quem o leitor vê (conexão, criador, a própria conta); sem conta, não', async () => {
    await expect(
      policyWith({ connected: [OTHER] }).policy.canBlockOrReport(viewer, person),
    ).resolves.toBe(true);
    await expect(policyWith().policy.canBlockOrReport(viewer, creator)).resolves.toBe(true);
    await expect(policyWith().policy.canBlockOrReport(viewer, self)).resolves.toBe(true);
    await expect(policyWith().policy.canBlockOrReport(viewer, person)).resolves.toBe(false);
    await expect(
      policyWith({ blocked: [OTHER] }).policy.canBlockOrReport(viewer, creator),
    ).resolves.toBe(false);
    await expect(policyWith().policy.canBlockOrReport(viewer, undefined)).resolves.toBe(false);
  });
});

describe('denunciar a conta de quem você bloqueou (R1-PO-1, canReportAccount)', () => {
  const person = { id: OTHER, accountType: 'personal' as const };
  const creator = { id: OTHER, accountType: 'creator' as const };
  const self = { id: viewer.userId, accountType: 'personal' as const };

  it('[PROX-65] [X.1] o leitor bloqueou o alvo → pode (pessoal ou criador, leitor pessoal ou criador, também com bloqueio nos dois sentidos)', async () => {
    for (const [who, target] of [
      [viewer, person],
      [viewer, creator],
      [creatorViewer, person],
    ] as const) {
      const { policy, relations } = policyWith({ iBlocked: [OTHER] });
      await expect(policy.canReportAccount(who, target)).resolves.toBe(true);
      expect(relations.hasBlocked).toHaveBeenCalledWith(viewer.userId, OTHER);
    }
    await expect(
      policyWith({ iBlocked: [OTHER], blocked: [OTHER] }).policy.canReportAccount(viewer, person),
    ).resolves.toBe(true);
  });

  it('[PROX-65] [X.1] só o alvo bloqueou o leitor → não pode', async () => {
    const { policy, relations } = policyWith({ blocked: [OTHER] });
    await expect(policy.canReportAccount(viewer, person)).resolves.toBe(false);
    expect(relations.hasBlocked).toHaveBeenCalledWith(viewer.userId, OTHER);
  });

  it('[PROX-65] [X.1] sem bloqueio → não pode; o bloqueio é consultado mesmo assim (sem atalho pela relação, o tempo não revela o bloqueio do alvo)', async () => {
    const { policy, relations } = policyWith();
    await expect(policy.canReportAccount(viewer, person)).resolves.toBe(false);
    expect(relations.hasBlocked).toHaveBeenCalledTimes(1);
    expect(relations.hasBlocked).toHaveBeenCalledWith(viewer.userId, OTHER);
  });

  it('[PROX-65] [X.1] perfil visível (conexão, criador, a própria conta) → pode, sem consultar o bloqueio', async () => {
    const connected = policyWith({ connected: [OTHER] });
    await expect(connected.policy.canReportAccount(viewer, person)).resolves.toBe(true);
    const others = policyWith();
    await expect(others.policy.canReportAccount(viewer, creator)).resolves.toBe(true);
    await expect(others.policy.canReportAccount(viewer, self)).resolves.toBe(true);
    expect(connected.relations.hasBlocked).not.toHaveBeenCalled();
    expect(others.relations.hasBlocked).not.toHaveBeenCalled();
  });

  it('[PROX-65] [X.1] sem conta (@ inexistente, excluído ou inválido): nunca pode', async () => {
    const { policy, relations } = policyWith({ iBlocked: [OTHER] });
    await expect(policy.canReportAccount(viewer, undefined)).resolves.toBe(false);
    expect(relations.hasBlocked).not.toHaveBeenCalled();
  });
});

describe('bloquear e denunciar a outra pessoa de um pedido de conexão recente (ADR 0013)', () => {
  const person = { id: OTHER, accountType: 'personal' as const };
  const THIRD = '01a189e0-af57-7000-85fe-2054e618fe09';
  const now = FakeClock.DEFAULT_START.getTime();
  const hoursAgo = (hours: number) => new Date(now - hours * 3600 * 1000);

  it('[NFC-MOD-01] pedido entre os dois há menos de 24 h, sem perfil visível → bloqueia e denuncia', async () => {
    const { policy, connections } = policyWith({ requests: { [OTHER]: hoursAgo(23) } });
    await expect(policy.canBlockOrReport(viewer, person)).resolves.toBe(true);
    await expect(policy.canReportAccount(viewer, person)).resolves.toBe(true);
    expect(connections.hasRecentRequestBetween).toHaveBeenCalledWith(
      viewer.userId,
      OTHER,
      hoursAgo(24),
    );
  });

  it('[NFC-MOD-02] sem pedido, ou pedido com 24 h ou mais → não pode', async () => {
    for (const requests of [{}, { [OTHER]: hoursAgo(24) }, { [OTHER]: hoursAgo(25) }]) {
      const { policy } = policyWith({ requests });
      await expect(policy.canBlockOrReport(viewer, person)).resolves.toBe(false);
      await expect(policy.canReportAccount(viewer, person)).resolves.toBe(false);
    }
  });

  it('[NFC-MOD-03] a janela anda com o relógio: o mesmo pedido deixa de valer depois de 24 h', async () => {
    const { policy, clock } = policyWith({ requests: { [OTHER]: hoursAgo(0) } });
    await expect(policy.canBlockOrReport(viewer, person)).resolves.toBe(true);
    clock.advance(24 * 3600 * 1000);
    await expect(policy.canBlockOrReport(viewer, person)).resolves.toBe(false);
    await expect(policy.canReportAccount(viewer, person)).resolves.toBe(false);
  });

  it('[NFC-MOD-04] o pedido com outra pessoa não vale para um terceiro', async () => {
    const { policy } = policyWith({ requests: { [THIRD]: hoursAgo(1) } });
    await expect(policy.canBlockOrReport(viewer, person)).resolves.toBe(false);
    await expect(policy.canReportAccount(viewer, person)).resolves.toBe(false);
  });

  it('[NFC-MOD-05] perfil visível: não consulta o pedido; sem conta: não consulta nada', async () => {
    const visible = policyWith({ connected: [OTHER] });
    await expect(visible.policy.canBlockOrReport(viewer, person)).resolves.toBe(true);
    await expect(visible.policy.canReportAccount(viewer, person)).resolves.toBe(true);
    expect(visible.connections.hasRecentRequestBetween).not.toHaveBeenCalled();
    const none = policyWith({ requests: { [OTHER]: hoursAgo(1) } });
    await expect(none.policy.canBlockOrReport(viewer, undefined)).resolves.toBe(false);
    await expect(none.policy.canReportAccount(viewer, undefined)).resolves.toBe(false);
    expect(none.connections.hasRecentRequestBetween).not.toHaveBeenCalled();
  });

  it('[NFC-MOD-06] denúncia: o pedido e o bloqueio são consultados juntos para todo alvo não visível (sem atalho, o tempo não revela nada)', async () => {
    const { policy, relations, connections } = policyWith({
      requests: { [OTHER]: hoursAgo(1) },
    });
    await expect(policy.canReportAccount(viewer, person)).resolves.toBe(true);
    expect(connections.hasRecentRequestBetween).toHaveBeenCalledTimes(1);
    expect(relations.hasBlocked).toHaveBeenCalledTimes(1);
  });

  it('[NFC-MOD-07] com bloqueio em algum sentido e pedido recente, ainda pode bloquear e denunciar (a resposta não muda)', async () => {
    const { policy } = policyWith({ blocked: [OTHER], requests: { [OTHER]: hoursAgo(1) } });
    await expect(policy.canBlockOrReport(viewer, person)).resolves.toBe(true);
    await expect(policy.canReportAccount(viewer, person)).resolves.toBe(true);
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
