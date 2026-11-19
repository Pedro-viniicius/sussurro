import { ErrorCode } from '@sussurro/shared';
import { describe, expect, it, vi } from 'vitest';

import type { BlocksRepository } from './blocks.repository.js';
import { BlocksService } from './blocks.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import type { DomainError } from '../../common/errors/domain-error.js';
import type { RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { FakeClock } from '../../testing/fake-clock.js';
import type { CommentsService } from '../comments/comments.service.js';
import type { ConnectionsRepository } from '../connections/connections.repository.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';
import type { RelationsRepository } from '../policies/relations.repository.js';
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
 * O bloqueio com o banco dublado. A política é a de verdade, sobre relações dubladas
 * (`connected`/`blocked`). (ADR 0013) Sem par encostado nem sinal depois do encosto.
 */
function setup() {
  // A trava do par (`pg_advisory_xact_lock`) roda no `execute` da transação.
  const tx = { execute: vi.fn(() => Promise.resolve({ rows: [] })) };
  const blocks = {
    db: {
      transaction: vi.fn((work: (executor: typeof tx) => Promise<void>) => work(tx)),
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
  /** Sem pedido de conexão recente entre os dois (a janela de 24 h tem teste próprio na política). */
  const connections = { hasRecentRequestBetween: vi.fn(() => Promise.resolve(false)) };
  const policy = new AccessPolicyService(
    relations as unknown as RelationsRepository,
    connections as unknown as ConnectionsRepository,
    new FakeClock(),
  );
  const rateLimiter = { consume: vi.fn(() => Promise.resolve()) };
  const notifications = { removeBetween: vi.fn(() => Promise.resolve()) };
  const service = new BlocksService(
    blocks as unknown as BlocksRepository,
    users as unknown as UsersService,
    comments as unknown as CommentsService,
    policy,
    rateLimiter as unknown as RateLimiterService,
    notifications as unknown as NotificationsService,
    new FakeClock(),
  );
  return { service, blocks, relation };
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

describe('BlocksService: bloquear pelo @ (ADR 0013: só quem a pessoa vê)', () => {
  it('[PROX-61] alvo visível (conexão): grava o bloqueio, sem depender do Valkey', async () => {
    const t = setup();
    await t.service.block(viewer, { handle: 'ana' });
    expect(t.blocks.insert).toHaveBeenCalledWith(expect.anything(), V, M, expect.any(Date));
  });

  it('[PROX-61] desconhecido, ou quem já bloqueou quem chama: 204 sem gravar, como o A-05', async () => {
    const t = setup();
    t.relation.connected = false;
    await expect(t.service.block(viewer, { handle: 'ana' })).resolves.toBeUndefined();
    t.relation.blocked = true;
    await expect(t.service.block(viewer, { handle: 'ana' })).resolves.toBeUndefined();
    expect(t.blocks.insert).not.toHaveBeenCalled();
  });

  it('[PROX-61] @ inexistente, excluído ou inválido: 204 sem gravar', async () => {
    const t = setup();
    for (const handle of ['ninguem', 'excluida', 'Inválido!']) {
      await expect(t.service.block(viewer, { handle })).resolves.toBeUndefined();
    }
    expect(t.blocks.insert).not.toHaveBeenCalled();
  });

  it('[PROX-61] o próprio @ → 400', async () => {
    const t = setup();
    const result = await failure(t.service.block(viewer, { handle: 'eu' }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(t.blocks.insert).not.toHaveBeenCalled();
  });

  it('[PROX-61] criador com bloqueio (perfil não visível): 204 sem gravar', async () => {
    const t = setup();
    t.relation.blocked = true;
    await t.service.block(viewer, { handle: 'loja' });
    expect(t.blocks.insert).not.toHaveBeenCalled();
  });

  it('[PROX-61] pelo commentId: grava só o autor de um comentário visível', async () => {
    const t = setup();
    t.relation.connected = false;
    await t.service.block(viewer, { commentId: 'c1' });
    await t.service.block(viewer, { commentId: 'c2' });
    expect(t.blocks.insert).toHaveBeenCalledTimes(1);
  });

  it('[PROX-61] a transação falhou: o erro do banco sobe', async () => {
    const t = setup();
    t.blocks.insert.mockRejectedValueOnce(new Error('banco fora'));
    await expect(t.service.block(viewer, { handle: 'ana' })).rejects.toThrow('banco fora');
  });
});
