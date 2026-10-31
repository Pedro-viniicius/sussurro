import { ErrorCode } from '@sussurro/shared';
import { describe, expect, it, vi } from 'vitest';

import type { BlocksRepository } from './blocks.repository.js';
import { BlocksService } from './blocks.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import type { DomainError } from '../../common/errors/domain-error.js';
import type { RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { FakeClock } from '../../testing/fake-clock.js';
import type { CommentsService } from '../comments/comments.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';
import type { RelationsRepository } from '../policies/relations.repository.js';
import {
  type ProximityAbuseFlag,
  type ProximityService,
  proximityUnavailable,
} from '../proximity/proximity.service.js';
import type { ModerationSignalsService } from '../reports/moderation-signals.service.js';
import type { UsersService } from '../users/users.service.js';

const M = '01a189e0-af57-7000-85fe-2054e618fe0a';
const V = '01a189e0-af57-7000-85fe-2054e618fe0b';
const CREATOR = '01a189e0-af57-7000-85fe-2054e618fe0c';

const viewer: AuthContext = {
  userId: V,
  accountType: 'personal',
  familyId: 'f',
  emailVerified: true,
};

const ACCOUNTS: Record<string, { id: string; accountType: 'personal' | 'creator' }> = {
  ana: { id: M, accountType: 'personal' },
  eu: { id: V, accountType: 'personal' },
  loja: { id: CREATOR, accountType: 'creator' },
};

/**
 * O bloqueio com o banco dublado, registrando a ordem: transação, depois o sinal (A2-3). A política
 * é a de verdade, sobre relações dubladas (`connected`/`blocked`); o par vivo vem de
 * `proximity.hasLiveTouchPair` (A2 rev. 1, R1-5).
 */
function setup(flags: ProximityAbuseFlag[] = []) {
  const order: string[] = [];
  // A trava do par (`pg_advisory_xact_lock`) roda no `execute` da transação.
  const tx = { execute: vi.fn(() => Promise.resolve({ rows: [] })) };
  const blocks = {
    db: {
      transaction: vi.fn(async (work: (executor: typeof tx) => Promise<void>) => {
        await work(tx);
        order.push('commit');
      }),
    },
    insert: vi.fn(() => Promise.resolve()),
    removeRelations: vi.fn(() => Promise.resolve()),
  };
  const users = {
    findActiveAccount: vi.fn((handle: string) => Promise.resolve(ACCOUNTS[handle])),
  };
  const comments = {
    findVisibleComment: vi.fn((_viewer: AuthContext, commentId: string) =>
      Promise.resolve(commentId === 'c1' ? { authorId: M } : undefined),
    ),
    removeBetween: vi.fn(() => Promise.resolve()),
  };
  const relation = { connected: true, blocked: false };
  const relations = {
    relationship: vi.fn(() => Promise.resolve({ ...relation })),
  };
  const policy = new AccessPolicyService(relations as unknown as RelationsRepository);
  const rateLimiter = { consume: vi.fn(() => Promise.resolve()) };
  const notifications = { removeBetween: vi.fn(() => Promise.resolve()) };
  const pair = { live: false, down: false };
  const proximity = {
    hasLiveTouchPair: vi.fn((_viewerId: string, _otherId: string | undefined) =>
      pair.down ? Promise.reject(proximityUnavailable()) : Promise.resolve(pair.live),
    ),
    noteBlockAfterTouch: vi.fn(() => {
      order.push('sinal');
      return Promise.resolve(flags);
    }),
  };
  const moderationSignals = {
    proximityBlockAfterTouch: vi.fn(() => {
      order.push('moderação');
      return Promise.resolve();
    }),
  };
  const service = new BlocksService(
    blocks as unknown as BlocksRepository,
    users as unknown as UsersService,
    comments as unknown as CommentsService,
    policy,
    rateLimiter as unknown as RateLimiterService,
    notifications as unknown as NotificationsService,
    proximity as unknown as ProximityService,
    moderationSignals as unknown as ModerationSignalsService,
    new FakeClock(),
  );
  return { service, order, blocks, proximity, moderationSignals, relation, pair };
}

async function failure(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
  } catch (error) {
    const domain = error as DomainError;
    return { status: domain.httpStatus, body: { code: domain.code, message: domain.message } };
  }
  return { status: 204, body: undefined };
}

describe('BlocksService: sinal de bloqueio depois do encosto (ADR 0012, A2-3)', () => {
  it('[PROX-55] bloqueio gravado: o sinal roda depois do commit, com quem bloqueou e quem foi bloqueado', async () => {
    const t = setup();
    await t.service.block(viewer, { handle: 'ana' });
    expect(t.blocks.insert).toHaveBeenCalledTimes(1);
    expect(t.proximity.noteBlockAfterTouch).toHaveBeenCalledWith(V, M);
    expect(t.order).toEqual(['commit', 'sinal']);
    expect(t.moderationSignals.proximityBlockAfterTouch).not.toHaveBeenCalled();
  });

  it('[PROX-55] cada papel que chegou ao 3º vira um sinal para a moderação', async () => {
    const flags: ProximityAbuseFlag[] = [
      { userId: V, role: 'blocker' },
      { userId: M, role: 'blocked' },
    ];
    const t = setup(flags);
    await t.service.block(viewer, { handle: 'ana' });
    expect(t.moderationSignals.proximityBlockAfterTouch.mock.calls).toEqual([
      [flags[0]],
      [flags[1]],
    ]);
    expect(t.order).toEqual(['commit', 'sinal', 'moderação', 'moderação']);
  });

  it('[PROX-55] bloqueio sem par não grava e não soma (perfil que a pessoa não vê, @ inexistente)', async () => {
    const t = setup();
    t.relation.connected = false;
    await t.service.block(viewer, { handle: 'ana' });
    await t.service.block(viewer, { handle: 'ninguem' });
    expect(t.blocks.insert).not.toHaveBeenCalled();
    expect(t.proximity.noteBlockAfterTouch).not.toHaveBeenCalled();
  });

  it('[PROX-55] a transação falhou: nenhum sinal (o erro do banco segue como antes)', async () => {
    const t = setup();
    t.blocks.insert.mockRejectedValueOnce(new Error('banco fora'));
    await expect(t.service.block(viewer, { handle: 'ana' })).rejects.toThrow('banco fora');
    expect(t.proximity.noteBlockAfterTouch).not.toHaveBeenCalled();
  });
});

describe('BlocksService: bloquear pelo cartão do encosto (ADR 0012, A2 rev. 1, R1-5)', () => {
  it('[PROX-61] desconhecidos com par vivo: grava (e o sinal soma), consultando o par com o id do alvo', async () => {
    const t = setup();
    t.relation.connected = false;
    t.pair.live = true;
    await t.service.block(viewer, { handle: 'ana' });
    expect(t.proximity.hasLiveTouchPair).toHaveBeenCalledWith(V, M);
    expect(t.blocks.insert).toHaveBeenCalledWith(expect.anything(), V, M, expect.any(Date));
    expect(t.proximity.noteBlockAfterTouch).toHaveBeenCalledWith(V, M);
  });

  it('[PROX-61] também quando o outro já bloqueou quem chama (o perfil não é visível)', async () => {
    const t = setup();
    t.relation.blocked = true;
    t.pair.live = true;
    await t.service.block(viewer, { handle: 'ana' });
    expect(t.blocks.insert).toHaveBeenCalledTimes(1);
  });

  it('[PROX-61] sem par (sem encosto ou depois dos 60 s): 204 sem gravar, como o A-05', async () => {
    const t = setup();
    t.relation.connected = false;
    await expect(t.service.block(viewer, { handle: 'ana' })).resolves.toBeUndefined();
    expect(t.proximity.hasLiveTouchPair).toHaveBeenCalledWith(V, M);
    expect(t.blocks.insert).not.toHaveBeenCalled();
  });

  it('[PROX-61] @ inexistente, excluído ou inválido: consulta o par mesmo assim (sem conta) e não grava, mesmo que a consulta dissesse que sim', async () => {
    const t = setup();
    t.pair.live = true;
    for (const handle of ['ninguem', 'excluida', 'Inválido!']) {
      await expect(t.service.block(viewer, { handle })).resolves.toBeUndefined();
    }
    expect(t.proximity.hasLiveTouchPair.mock.calls).toEqual([
      [V, undefined],
      [V, undefined],
      [V, undefined],
    ]);
    expect(t.blocks.insert).not.toHaveBeenCalled();
  });

  it('[PROX-61] o próprio @ → 400, sem consultar o par', async () => {
    const t = setup();
    t.pair.live = true;
    const result = await failure(t.service.block(viewer, { handle: 'eu' }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(t.proximity.hasLiveTouchPair).not.toHaveBeenCalled();
    expect(t.blocks.insert).not.toHaveBeenCalled();
  });

  it('[PROX-61] criador que a pessoa não vê, com par: 204 sem gravar (o par só vale entre contas pessoais)', async () => {
    const t = setup();
    t.relation.blocked = true;
    t.pair.live = true;
    await t.service.block(viewer, { handle: 'loja' });
    expect(t.blocks.insert).not.toHaveBeenCalled();
  });

  it('[PROX-61] Valkey fora com alvo não visível → 503 PROXIMITY_UNAVAILABLE com o mesmo corpo para @ existente com e sem par, inexistente, excluído e inválido; nada gravado', async () => {
    const t = setup();
    t.relation.connected = false;
    t.pair.down = true;
    const answers = [];
    for (const handle of ['ana', 'ninguem', 'excluida', 'Inválido!']) {
      answers.push(await failure(t.service.block(viewer, { handle })));
    }
    t.pair.live = true;
    answers.push(await failure(t.service.block(viewer, { handle: 'ana' })));
    for (const answer of answers) {
      expect(answer).toEqual({
        status: 503,
        body: {
          code: ErrorCode.PROXIMITY_UNAVAILABLE,
          message: 'Conectar está indisponível agora. Tente de novo em instantes.',
        },
      });
    }
    expect(t.blocks.insert).not.toHaveBeenCalled();
    expect(t.proximity.noteBlockAfterTouch).not.toHaveBeenCalled();
  });

  it('[PROX-61] alvo visível (conexão) com o Valkey fora → grava, sem consultar o par', async () => {
    const t = setup();
    t.pair.down = true;
    await t.service.block(viewer, { handle: 'ana' });
    expect(t.proximity.hasLiveTouchPair).not.toHaveBeenCalled();
    expect(t.blocks.insert).toHaveBeenCalledTimes(1);
  });

  it('[PROX-61] o bloqueio pelo commentId não muda: não consulta o par', async () => {
    const t = setup();
    t.relation.connected = false;
    await t.service.block(viewer, { commentId: 'c1' });
    await t.service.block(viewer, { commentId: 'c2' });
    expect(t.proximity.hasLiveTouchPair).not.toHaveBeenCalled();
    expect(t.blocks.insert).toHaveBeenCalledTimes(1);
  });
});
