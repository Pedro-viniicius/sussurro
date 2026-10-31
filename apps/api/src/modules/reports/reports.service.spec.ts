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
import { AccessPolicyService } from '../policies/access-policy.service.js';
import type { RelationsRepository } from '../policies/relations.repository.js';
import type { PostsService } from '../posts/posts.service.js';
import { type ProximityService, proximityUnavailable } from '../proximity/proximity.service.js';
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
 * A denúncia com o banco e o e-mail dublados. A política é a de verdade, sobre relações dubladas;
 * o par vivo vem de `proximity.hasLiveTouchPair` (ADR 0012, A2 rev. 1, R1-5).
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
  const relations = { relationship: vi.fn(() => Promise.resolve({ ...relation })) };
  const policy = new AccessPolicyService(relations as unknown as RelationsRepository);
  const pair = { live: false, down: false };
  const proximity = {
    hasLiveTouchPair: vi.fn((_viewerId: string, _otherId: string | undefined) =>
      pair.down ? Promise.reject(proximityUnavailable()) : Promise.resolve(pair.live),
    ),
  };
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
    proximity as unknown as ProximityService,
    sender,
    rateLimiter as unknown as RateLimiterService,
    new FakeClock(),
    new AppConfig(testEnv({ MODERATION_EMAIL: 'moderacao@sussurro.app' })),
  );
  return { service, inserted, sent, proximity, relation, pair };
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

describe('ReportsService: denunciar a conta pelo cartão do encosto (ADR 0012, A2 rev. 1, R1-5)', () => {
  it('[PROX-62] com o par vivo, sem ver o perfil: grava a denúncia da conta (target_user_id = M) e manda o e-mail', async () => {
    const t = setup();
    t.pair.live = true;
    await t.service.create(viewer, account('mallory'));
    expect(t.proximity.hasLiveTouchPair).toHaveBeenCalledWith(V, M);
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

  it('[PROX-62] também quando M bloqueou V (o perfil não é visível)', async () => {
    const t = setup();
    t.relation.blocked = true;
    t.pair.live = true;
    await t.service.create(viewer, account('mallory'));
    expect(t.inserted).toHaveLength(1);
  });

  it('[PROX-62] sem par (ou 60 s depois): o mesmo 404 de @ inexistente (X.1 CA1), nada gravado nem enviado', async () => {
    const t = setup();
    const answers = [
      await failure(t.service.create(viewer, account('mallory'))),
      await failure(t.service.create(viewer, account('ninguem'))),
    ];
    expect(answers).toEqual([NOT_FOUND, NOT_FOUND]);
    expect(t.proximity.hasLiveTouchPair.mock.calls).toEqual([
      [V, M],
      [V, undefined],
    ]);
    expect(t.inserted).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('[PROX-62] conta excluída ou @ inexistente com a consulta do par dizendo que sim → 404 (sem conta, nunca pode)', async () => {
    const t = setup();
    t.pair.live = true;
    expect(await failure(t.service.create(viewer, account('excluida')))).toEqual(NOT_FOUND);
    expect(t.proximity.hasLiveTouchPair).toHaveBeenCalledWith(V, undefined);
    expect(t.inserted).toEqual([]);
  });

  it('[PROX-62] Valkey fora com alvo não visível → 503 PROXIMITY_UNAVAILABLE igual para @ existente e inexistente; nada gravado nem enviado', async () => {
    const t = setup();
    t.pair.down = true;
    const unavailable = {
      status: 503,
      body: {
        code: ErrorCode.PROXIMITY_UNAVAILABLE,
        message: 'Conectar está indisponível agora. Tente de novo em instantes.',
      },
    };
    expect(await failure(t.service.create(viewer, account('mallory')))).toEqual(unavailable);
    expect(await failure(t.service.create(viewer, account('ninguem')))).toEqual(unavailable);
    expect(t.inserted).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('[PROX-62] perfil visível (conexão): como sempre, sem consultar o par (Valkey fora não importa)', async () => {
    const t = setup();
    t.relation.connected = true;
    t.pair.down = true;
    await t.service.create(viewer, account('mallory'));
    expect(t.proximity.hasLiveTouchPair).not.toHaveBeenCalled();
    expect(t.inserted).toHaveLength(1);
  });

  it('[PROX-62] a própria conta → 400, como antes', async () => {
    const t = setup();
    expect((await failure(t.service.create(viewer, account('eu')))).status).toBe(400);
    expect(t.proximity.hasLiveTouchPair).not.toHaveBeenCalled();
  });

  it('[PROX-62] post e comentário seguem a regra de sempre: não consultam o par', async () => {
    const t = setup();
    t.pair.live = true;
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
    expect(t.proximity.hasLiveTouchPair).not.toHaveBeenCalled();
  });
});
