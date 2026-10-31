import { describe, expect, it, vi } from 'vitest';

import {
  AccessPolicyService,
  isConnectionRequestAllowed,
  isFollowAllowed,
  isPostVisible,
  isProfileVisible,
  isTouchActionAllowed,
  type PostTarget,
  type Relationship,
  type TouchParty,
  touchRevealParties,
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

/**
 * `blocked`: contas com bloqueio com o leitor; para o `hasBlocked`, foram elas que bloquearam o
 * leitor. `iBlocked`: contas que o leitor bloqueou (o sentido da R1-PO-1); a relação também as dá
 * como bloqueadas.
 */
function policyWith(
  options: { connected?: string[]; blocked?: string[]; iBlocked?: string[] } = {},
) {
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

describe('bloquear e denunciar pelo cartão do encosto (ADR 0012, A2 rev. 1, R1-5)', () => {
  const person = { id: OTHER, accountType: 'personal' as const };
  const creator = { id: OTHER, accountType: 'creator' as const };
  const self = { id: viewer.userId, accountType: 'personal' as const };

  it('[PROX-61] [PROX-62] isTouchActionAllowed: só com o par vivo, entre duas contas pessoais diferentes', () => {
    expect(isTouchActionAllowed(viewer, person, true)).toBe(true);
    expect(isTouchActionAllowed(viewer, person, false)).toBe(false);
    expect(isTouchActionAllowed(viewer, creator, true)).toBe(false);
    expect(isTouchActionAllowed(creatorViewer, person, true)).toBe(false);
    expect(isTouchActionAllowed(viewer, self, true)).toBe(false);
  });

  it('[PROX-61] [PROX-62] perfil visível (conexão, criador, a própria conta) → pode, sem consultar o par', async () => {
    const touchPair = vi.fn((_targetId: string | undefined) => Promise.resolve(false));
    await expect(
      policyWith({ connected: [OTHER] }).policy.canBlockOrReport(viewer, person, touchPair),
    ).resolves.toBe(true);
    await expect(policyWith().policy.canBlockOrReport(viewer, creator, touchPair)).resolves.toBe(
      true,
    );
    await expect(policyWith().policy.canBlockOrReport(viewer, self, touchPair)).resolves.toBe(true);
    expect(touchPair).not.toHaveBeenCalled();
  });

  it('[PROX-61] [PROX-62] perfil que não se vê: pode só com o par vivo, também quando um já bloqueou o outro', async () => {
    const paired = vi.fn((_targetId: string | undefined) => Promise.resolve(true));
    const unpaired = vi.fn((_targetId: string | undefined) => Promise.resolve(false));
    await expect(policyWith().policy.canBlockOrReport(viewer, person, paired)).resolves.toBe(true);
    expect(paired).toHaveBeenLastCalledWith(OTHER);
    await expect(policyWith().policy.canBlockOrReport(viewer, person, unpaired)).resolves.toBe(
      false,
    );
    await expect(
      policyWith({ blocked: [OTHER] }).policy.canBlockOrReport(viewer, person, paired),
    ).resolves.toBe(true);
    // Criador que não se vê (bloqueio) ou leitor criador: o par não vale (não há encosto com criador).
    await expect(
      policyWith({ blocked: [OTHER] }).policy.canBlockOrReport(viewer, creator, paired),
    ).resolves.toBe(false);
    await expect(policyWith().policy.canBlockOrReport(creatorViewer, person, paired)).resolves.toBe(
      false,
    );
  });

  it('[PROX-61] [PROX-62] sem conta (@ inexistente, excluído ou inválido): consulta o par mesmo assim, com undefined, e nunca pode', async () => {
    const touchPair = vi.fn((_targetId: string | undefined) => Promise.resolve(true));
    await expect(policyWith().policy.canBlockOrReport(viewer, undefined, touchPair)).resolves.toBe(
      false,
    );
    expect(touchPair).toHaveBeenCalledTimes(1);
    expect(touchPair).toHaveBeenCalledWith(undefined);
  });

  it('[PROX-61] [PROX-62] a falha da consulta do par (Valkey fora, 503) sobe igual para alvo com e sem conta', async () => {
    const failure = new Error('503');
    const touchPair = vi.fn((_targetId: string | undefined) => Promise.reject(failure));
    await expect(policyWith().policy.canBlockOrReport(viewer, person, touchPair)).rejects.toBe(
      failure,
    );
    await expect(policyWith().policy.canBlockOrReport(viewer, undefined, touchPair)).rejects.toBe(
      failure,
    );
    // Alvo visível não depende do Valkey.
    await expect(
      policyWith({ connected: [OTHER] }).policy.canBlockOrReport(viewer, person, touchPair),
    ).resolves.toBe(true);
  });

  it('[PROX-65] [PROX-61] [X.2] regressão (R1-PO-1): o bloqueio não ganha a regra "quem você bloqueou"; sem par → não pode, Valkey fora → o erro sobe, sem consultar o bloqueio', async () => {
    const { policy, relations } = policyWith({ iBlocked: [OTHER] });
    const unpaired = vi.fn((_targetId: string | undefined) => Promise.resolve(false));
    await expect(policy.canBlockOrReport(viewer, person, unpaired)).resolves.toBe(false);
    expect(unpaired).toHaveBeenCalledWith(OTHER);
    const failure = new Error('503');
    const down = vi.fn((_targetId: string | undefined) => Promise.reject(failure));
    await expect(policy.canBlockOrReport(viewer, person, down)).rejects.toBe(failure);
    expect(relations.hasBlocked).not.toHaveBeenCalled();
  });
});

describe('revelar os cartões no encosto (ADR 0012, A3-1, R22: touchRevealParties)', () => {
  /** Uma linha do `findTouchPair`: pessoal, ativa, sem bloqueio, com o @ (que volta como veio). */
  function party(id: string, overrides: Partial<TouchParty> = {}) {
    return { id, personal: true, active: true, blocked: false, handle: `@${id}`, ...overrides };
  }

  it('[PROX-66] [X.2] as duas contas pessoais, ativas e sem bloqueio → as duas linhas (com o que vier junto), em qualquer ordem; o serviço dá a mesma resposta e não consulta nada', () => {
    const owner = party(OTHER);
    const caller = party(viewer.userId);
    for (const rows of [
      [owner, caller],
      [caller, owner],
    ]) {
      expect(touchRevealParties(viewer, OTHER, rows)).toEqual({ owner, caller });
      expect(touchRevealParties(viewer, OTHER, rows)?.owner).toBe(owner);
    }
    const { policy, relations } = policyWith();
    expect(policy.touchRevealParties(viewer, OTHER, [caller, owner])).toEqual({ owner, caller });
    for (const query of Object.values(relations)) {
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('[PROX-66] [PROX-36] [X.2] recusa (null) com bloqueio (o do par, em qualquer sentido), conta excluída ou de criador de cada lado, conta sem linha de cada lado e a própria conta como dona', () => {
    const owner = party(OTHER);
    const caller = party(viewer.userId);
    const refused: [string, TouchParty[], string][] = [
      [
        'bloqueio do par',
        [party(OTHER, { blocked: true }), party(viewer.userId, { blocked: true })],
        OTHER,
      ],
      ['bloqueio na linha do dono', [party(OTHER, { blocked: true }), caller], OTHER],
      ['dono excluído', [party(OTHER, { active: false }), caller], OTHER],
      ['quem chama excluído', [owner, party(viewer.userId, { active: false })], OTHER],
      ['dono criador', [party(OTHER, { personal: false }), caller], OTHER],
      ['quem chama criador', [owner, party(viewer.userId, { personal: false })], OTHER],
      ['dono sem linha', [caller], OTHER],
      ['quem chama sem linha', [owner], OTHER],
      ['sem linhas', [], OTHER],
      ['a própria conta como dona', [caller], viewer.userId],
    ];
    for (const [name, rows, ownerId] of refused) {
      expect(touchRevealParties(viewer, ownerId, rows), name).toBeNull();
    }
  });
});

describe('denunciar a conta de quem você bloqueou (R1-PO-1, canReportAccount)', () => {
  const person = { id: OTHER, accountType: 'personal' as const };
  const creator = { id: OTHER, accountType: 'creator' as const };
  const self = { id: viewer.userId, accountType: 'personal' as const };
  const pairIs = (live: boolean) => vi.fn((_targetId: string | undefined) => Promise.resolve(live));

  it('[PROX-65] [PROX-62] [X.1] o leitor bloqueou o alvo → pode, sem consultar o par (pessoal ou criador, leitor pessoal ou criador, também com bloqueio nos dois sentidos)', async () => {
    const touchPair = pairIs(false);
    for (const [who, target] of [
      [viewer, person],
      [viewer, creator],
      [creatorViewer, person],
    ] as const) {
      const { policy, relations } = policyWith({ iBlocked: [OTHER] });
      await expect(policy.canReportAccount(who, target, touchPair)).resolves.toBe(true);
      expect(relations.hasBlocked).toHaveBeenCalledWith(viewer.userId, OTHER);
    }
    await expect(
      policyWith({ iBlocked: [OTHER], blocked: [OTHER] }).policy.canReportAccount(
        viewer,
        person,
        touchPair,
      ),
    ).resolves.toBe(true);
    expect(touchPair).not.toHaveBeenCalled();
  });

  it('[PROX-65] [PROX-62] [X.1] só o alvo bloqueou o leitor → não conta: segue o par (sem par não pode, com par pode)', async () => {
    const { policy, relations } = policyWith({ blocked: [OTHER] });
    const unpaired = pairIs(false);
    await expect(policy.canReportAccount(viewer, person, unpaired)).resolves.toBe(false);
    expect(relations.hasBlocked).toHaveBeenCalledWith(viewer.userId, OTHER);
    expect(unpaired).toHaveBeenCalledWith(OTHER);
    await expect(policy.canReportAccount(viewer, person, pairIs(true))).resolves.toBe(true);
  });

  it('[PROX-65] [PROX-62] [X.1] sem bloqueio e sem par → não pode; o bloqueio é consultado mesmo assim (sem atalho pela relação, o tempo não revela o bloqueio do alvo)', async () => {
    const { policy, relations } = policyWith();
    const unpaired = pairIs(false);
    await expect(policy.canReportAccount(viewer, person, unpaired)).resolves.toBe(false);
    expect(relations.hasBlocked).toHaveBeenCalledTimes(1);
    expect(relations.hasBlocked).toHaveBeenCalledWith(viewer.userId, OTHER);
    expect(unpaired).toHaveBeenCalledTimes(1);
    expect(unpaired).toHaveBeenCalledWith(OTHER);
  });

  it('[PROX-65] [PROX-62] [X.1] perfil visível (conexão, criador, a própria conta) → pode, sem consultar o bloqueio nem o par', async () => {
    const touchPair = pairIs(false);
    const connected = policyWith({ connected: [OTHER] });
    await expect(connected.policy.canReportAccount(viewer, person, touchPair)).resolves.toBe(true);
    const others = policyWith();
    await expect(others.policy.canReportAccount(viewer, creator, touchPair)).resolves.toBe(true);
    await expect(others.policy.canReportAccount(viewer, self, touchPair)).resolves.toBe(true);
    expect(connected.relations.hasBlocked).not.toHaveBeenCalled();
    expect(others.relations.hasBlocked).not.toHaveBeenCalled();
    expect(touchPair).not.toHaveBeenCalled();
  });

  it('[PROX-65] [PROX-62] [X.1] sem conta (@ inexistente, excluído ou inválido): consulta o par com undefined e nunca pode', async () => {
    const { policy, relations } = policyWith({ iBlocked: [OTHER] });
    const touchPair = pairIs(true);
    await expect(policy.canReportAccount(viewer, undefined, touchPair)).resolves.toBe(false);
    expect(touchPair).toHaveBeenCalledTimes(1);
    expect(touchPair).toHaveBeenCalledWith(undefined);
    expect(relations.hasBlocked).not.toHaveBeenCalled();
  });

  it('[PROX-65] [PROX-62] [X.1] Valkey fora: a conta que o leitor bloqueou passa (sem 503); o mesmo erro sobe para alvo sem bloqueio, bloqueado só pelo alvo e sem conta', async () => {
    const failure = new Error('503');
    const down = vi.fn((_targetId: string | undefined) => Promise.reject(failure));
    await expect(
      policyWith({ iBlocked: [OTHER] }).policy.canReportAccount(viewer, person, down),
    ).resolves.toBe(true);
    expect(down).not.toHaveBeenCalled();
    await expect(policyWith().policy.canReportAccount(viewer, person, down)).rejects.toBe(failure);
    await expect(
      policyWith({ blocked: [OTHER] }).policy.canReportAccount(viewer, person, down),
    ).rejects.toBe(failure);
    await expect(policyWith().policy.canReportAccount(viewer, undefined, down)).rejects.toBe(
      failure,
    );
    expect(down.mock.calls).toEqual([[OTHER], [OTHER], [undefined]]);
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
