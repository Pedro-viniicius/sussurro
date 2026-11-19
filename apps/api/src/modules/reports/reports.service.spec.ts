import { type CreateReportRequest, ErrorCode } from '@sussurro/shared';
import { describe, expect, it, vi } from 'vitest';

import type { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import type { DomainError } from '../../common/errors/domain-error.js';
import type { RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { AppConfig } from '../../config/config.module.js';
import type { EmailMessage } from '../../infra/email/email-sender.js';
import { FakeClock } from '../../testing/fake-clock.js';
import { testEnv } from '../../testing/test-env.js';
import type { CommentsService } from '../comments/comments.service.js';
import type { ConnectionsRepository } from '../connections/connections.repository.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';
import type { RelationsRepository } from '../policies/relations.repository.js';
import type { PostsService } from '../posts/posts.service.js';
import type { UsersService } from '../users/users.service.js';

const M = '01a189e0-af57-7000-85fe-2054e618fe0a';
const V = '01a189e0-af57-7000-85fe-2054e618fe0b';
const POST = '01a189e0-af57-7000-85fe-2054e618fe0c';

const viewer: AuthContext = {
  userId: V,
  accountType: 'personal',
  familyId: 'f',
  emailVerified: true,
};

const ACCOUNTS: Record<string, { id: string; handle: string; accountType: 'personal' }> = {
  mallory: { id: M, handle: 'mallory', accountType: 'personal' },
  eu: { id: V, handle: 'eu', accountType: 'personal' },
};

function account(handle: string): CreateReportRequest {
  return { target: { type: 'account', handle }, reason: 'harassment', details: null };
}

/**
 * A denúncia com o banco e o e-mail dublados. A política é a de verdade, sobre relações dubladas
 * (`relation` e os bloqueios com sentido em `blocks`, R1-PO-1).
 */
function setup() {
  const inserted: unknown[] = [];
  const reports = {
    insert: vi.fn((values: unknown) => {
      inserted.push(values);
      return Promise.resolve(`r${String(inserted.length)}`);
    }),
  };
  const posts = {
    findInteractable: vi.fn(() =>
      Promise.resolve({ id: POST, authorId: M, authorHandle: 'mallory' }),
    ),
  };
  const comments = { findVisibleComment: vi.fn(() => Promise.resolve(undefined)) };
  const users = {
    findActiveAccount: vi.fn((handle: string) => Promise.resolve(ACCOUNTS[handle])),
  };
  const relation = { connected: false, blocked: false };
  /** Bloqueios gravados, com sentido: `"{quem bloqueou}>{quem foi bloqueado}"` (R1-PO-1). */
  const blocks = new Set<string>();
  const relations = {
    relationship: vi.fn((viewerId: string, otherId: string) =>
      Promise.resolve({
        connected: relation.connected,
        blocked:
          relation.blocked ||
          blocks.has(`${viewerId}>${otherId}`) ||
          blocks.has(`${otherId}>${viewerId}`),
      }),
    ),
    hasBlocked: vi.fn((blockerId: string, blockedId: string) =>
      Promise.resolve(blocks.has(`${blockerId}>${blockedId}`)),
    ),
  };
  /** Sem pedido de conexão recente entre os dois (a janela de 24 h tem teste próprio na política). */
  const connections = { hasRecentRequestBetween: vi.fn(() => Promise.resolve(false)) };
  const policy = new AccessPolicyService(
    relations as unknown as RelationsRepository,
    connections as unknown as ConnectionsRepository,
    new FakeClock(),
  );
  const sent: EmailMessage[] = [];
  const sender = {
    send: vi.fn((message: EmailMessage) => {
      sent.push(message);
      return Promise.resolve();
    }),
  };
  const rateLimiter = { consume: vi.fn(() => Promise.resolve()) };
  const service = new ReportsService(
    reports as unknown as ReportsRepository,
    posts as unknown as PostsService,
    comments as unknown as CommentsService,
    users as unknown as UsersService,
    policy,
    sender,
    rateLimiter as unknown as RateLimiterService,
    new FakeClock(),
    new AppConfig(testEnv({ MODERATION_EMAIL: 'moderacao@sussurro.app' })),
  );
  return { service, inserted, sent, relation, relations, blocks };
}

async function failure(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
  } catch (error) {
    const domain = error as DomainError;
    return { status: domain.httpStatus, body: { code: domain.code, message: domain.message } };
  }
  return { status: 202, body: undefined };
}

const NOT_FOUND = {
  status: 404,
  body: { code: ErrorCode.NOT_FOUND, message: 'Perfil não encontrado' },
};

describe('ReportsService: denunciar a conta pelo @ (ADR 0013: sem o caminho do cartão do encosto)', () => {
  it('[PROX-62] perfil não visível e sem bloqueio: o mesmo 404 de @ inexistente (X.1 CA1), nada gravado nem enviado', async () => {
    const t = setup();
    const answers = [
      await failure(t.service.create(viewer, account('mallory'))),
      await failure(t.service.create(viewer, account('ninguem'))),
      await failure(t.service.create(viewer, account('excluida'))),
    ];
    expect(answers).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
    expect(t.inserted).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.sent).toEqual([]);
  });

  it('[PROX-62] perfil visível (conexão): grava a denúncia e manda o e-mail', async () => {
    const t = setup();
    t.relation.connected = true;
    await t.service.create(viewer, account('mallory'));
    expect(t.inserted).toEqual([
      expect.objectContaining({ reporterId: V, targetType: 'account', targetUserId: M }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain('Alvo: conta @mallory');
  });

  it('[PROX-62] a própria conta → 400, como antes', async () => {
    const t = setup();
    expect((await failure(t.service.create(viewer, account('eu')))).status).toBe(400);
  });
});

describe('ReportsService: denunciar a conta de quem você bloqueou (R1-PO-1)', () => {
  it('[PROX-65] [X.1] V bloqueou M: 202, grava a denúncia da conta e manda o e-mail', async () => {
    const t = setup();
    t.blocks.add(`${V}>${M}`);
    await t.service.create(viewer, account('mallory'));
    expect(t.relations.hasBlocked).toHaveBeenCalledWith(V, M);
    expect(t.inserted).toEqual([
      expect.objectContaining({
        reporterId: V,
        targetType: 'account',
        targetUserId: M,
        postId: null,
        commentId: null,
      }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain('Alvo: conta @mallory');
  });

  it('[PROX-65] [X.1] bloqueio nos dois sentidos: 202, gravado', async () => {
    const t = setup();
    t.blocks.add(`${V}>${M}`);
    t.blocks.add(`${M}>${V}`);
    await t.service.create(viewer, account('mallory'));
    expect(t.inserted).toHaveLength(1);
  });

  it('[PROX-65] [X.1] só M bloqueou V: não conta; o mesmo 404 de @ inexistente; nada gravado nem enviado', async () => {
    const t = setup();
    t.blocks.add(`${M}>${V}`);
    expect([
      await failure(t.service.create(viewer, account('mallory'))),
      await failure(t.service.create(viewer, account('ninguem'))),
    ]).toEqual([NOT_FOUND, NOT_FOUND]);
    expect(t.inserted).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.sent).toEqual([]);
  });

  it('[PROX-65] [X.1] depois do desbloqueio → o 404 de @ inexistente de novo', async () => {
    const t = setup();
    t.blocks.add(`${V}>${M}`);
    await t.service.create(viewer, account('mallory'));
    t.blocks.delete(`${V}>${M}`);
    expect(await failure(t.service.create(viewer, account('mallory')))).toEqual(NOT_FOUND);
    expect(t.inserted).toHaveLength(1);
  });

  it('[PROX-65] [X.1] post e comentário não ganham a regra: não consultam o bloqueio', async () => {
    const t = setup();
    t.blocks.add(`${V}>${M}`);
    await t.service.create(viewer, {
      target: { type: 'post', id: POST },
      reason: 'spam',
      details: null,
    });
    expect(
      (
        await failure(
          t.service.create(viewer, {
            target: { type: 'comment', id: POST },
            reason: 'spam',
            details: null,
          }),
        )
      ).status,
    ).toBe(404);
    expect(t.relations.hasBlocked).not.toHaveBeenCalled();
  });
});
