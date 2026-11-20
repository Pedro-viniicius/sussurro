import {
  ErrorCode,
  PROXIMITY_TOKEN_ISSUE_LIMIT_PER_MIN,
  ProximityTokenSchema,
} from '@sussurro/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashProximityToken, PROXIMITY_LIMITS } from './proximity-token.js';
import type { NearbyRow, ProximityRepository } from './proximity.repository.js';
import { ProximityService } from './proximity.service.js';
import { MemoryProximityStore } from './proximity.store.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import type { DomainError } from '../../common/errors/domain-error.js';
import { AppConfig } from '../../config/config.module.js';
import { FakeClock } from '../../testing/fake-clock.js';
import { testEnv } from '../../testing/test-env.js';
import type { MediaService } from '../media/media.service.js';
import type { AccessPolicyService } from '../policies/access-policy.service.js';

const A = '01a189e0-af57-7000-85fe-2054e618fe0a';
const B = '01a189e0-af57-7000-85fe-2054e618fe0b';
const C = '01a189e0-af57-7000-85fe-2054e618fe0c';
const UNKNOWN = 'AAAAAAAAAAAAAAAA';

function viewer(userId: string): AuthContext {
  return { userId, accountType: 'personal', familyId: 'f', emailVerified: true };
}

const PEOPLE: Record<string, Omit<NearbyRow, 'connected'>> = {
  [A]: { id: A, handle: 'ana', name: 'Ana', avatarKey: null },
  [B]: { id: B, handle: 'bia.alves', name: 'Bia Alves', avatarKey: 'avatars/b.jpg' },
  [C]: { id: C, handle: 'caio', name: 'Caio', avatarKey: null },
};

/** Store em memória em que cada operação pode falhar (Redis fora no meio, PROX-21). */
class SwitchableStore extends MemoryProximityStore {
  readonly failing = new Set<string>();

  private outage<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.failing.has(name) ? Promise.reject(new Error(`fora: ${name}`)) : operation();
  }

  override issue(...args: Parameters<MemoryProximityStore['issue']>) {
    return this.outage('issue', () => super.issue(...args));
  }

  override findValid(...args: Parameters<MemoryProximityStore['findValid']>) {
    return this.outage('findValid', () => super.findValid(...args));
  }

  override findRecent(...args: Parameters<MemoryProximityStore['findRecent']>) {
    return this.outage('findRecent', () => super.findRecent(...args));
  }

  override isScreenOpen(...args: Parameters<MemoryProximityStore['isScreenOpen']>) {
    return this.outage('isScreenOpen', () => super.isScreenOpen(...args));
  }

  override revokeUser(...args: Parameters<MemoryProximityStore['revokeUser']>) {
    return this.outage('revokeUser', () => super.revokeUser(...args));
  }

  override lockRemainingMs(...args: Parameters<MemoryProximityStore['lockRemainingMs']>) {
    return this.outage('lockRemainingMs', () => super.lockRemainingMs(...args));
  }

  override hit(...args: Parameters<MemoryProximityStore['hit']>) {
    return this.outage('hit', () => super.hit(...args));
  }
}

function setup() {
  const clock = new FakeClock();
  const store = new SwitchableStore(clock);
  /** Contas que a política esconde de quem chama (bloqueio, criador ou excluída). */
  const hidden = new Set<string>();
  const repository = {
    findNearby: vi.fn((_viewerId: string, ids: readonly string[]): Promise<NearbyRow[]> =>
      Promise.resolve(
        ids
          .filter((id) => id in PEOPLE && !hidden.has(id))
          .map((id) => ({ ...PEOPLE[id]!, connected: id === C })),
      ),
    ),
  };
  const policy = { hideBlockedFor: vi.fn(() => 'filtro-de-bloqueio') };
  const media = {
    signUrl: vi.fn((key: string | null) =>
      Promise.resolve(key === null ? null : `https://m/${key}`),
    ),
  };
  const service = new ProximityService(
    store,
    repository as unknown as ProximityRepository,
    policy as unknown as AccessPolicyService,
    media as unknown as MediaService,
    clock,
    new AppConfig(testEnv()),
  );
  return { clock, store, hidden, repository, service };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as DomainError).code;
  }
  return 'ok';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProximityService: emissão (ADR 0013 §1)', () => {
  it('[PROX-01] cada emissão traz um token só (o mesmo no QR e no NFC), gravado só como hash', async () => {
    const { service, store, clock } = setup();
    const issued = await service.issueToken(viewer(A));
    expect(ProximityTokenSchema.parse(issued)).toEqual(issued);
    expect(Object.keys(issued).sort()).toEqual(['expiresAt', 'renewInS', 'token']);
    expect(issued.expiresAt).toBe(new Date(clock.now().getTime() + 30_000).toISOString());
    expect(issued.renewInS).toBe(20);

    expect(await store.findValid([hashProximityToken(issued.token)])).toEqual([
      { userId: A, issuedAt: clock.now().getTime() },
    ]);
    expect(await store.isScreenOpen(A)).toBe(true);
    expect(JSON.stringify(store.entries())).not.toContain(issued.token);
  });

  it('[PROX-25] cada emissão gera um token novo', async () => {
    const { service } = setup();
    const first = await service.issueToken(viewer(A));
    const second = await service.issueToken(viewer(A));
    expect(first.token).not.toBe(second.token);
  });

  it('[PROX-20] o limite de 6 por minuto (PROXIMITY_TOKEN_ISSUE_LIMIT_PER_MIN) conta a emissão', async () => {
    const { service } = setup();
    // O número é o do `packages/shared`, o mesmo que o app usa para não pedir acima dele (PROX-68).
    expect(PROXIMITY_LIMITS.tokens.limit).toBe(PROXIMITY_TOKEN_ISSUE_LIMIT_PER_MIN);
    expect(PROXIMITY_LIMITS.tokens.windowMs).toBe(60_000);
    for (let index = 0; index < PROXIMITY_LIMITS.tokens.limit; index++) {
      await service.issueToken(viewer(A));
    }
    expect(await codeOf(service.issueToken(viewer(A)))).toBe(ErrorCode.RATE_LIMITED);
  });

  it('[PROX-02] [PROX-03] dono do token: válido até 30 s (pedido), recente até 120 s (aceite)', async () => {
    const { service, clock } = setup();
    const { token } = await service.issueToken(viewer(A));
    expect(await service.ownerOfValidToken(token)).toBe(A);
    expect(await service.ownerOfRecentToken(token)).toBe(A);
    expect(await service.ownerOfValidToken(UNKNOWN)).toBeNull();
    clock.advance(30_000);
    expect(await service.ownerOfValidToken(token)).toBeNull();
    expect(await service.ownerOfRecentToken(token)).toBe(A);
    clock.advance(90_000);
    expect(await service.ownerOfRecentToken(token)).toBeNull();
  });

  it('[PROX-42] issueForSimulation grava o token da persona com a mesma validade', async () => {
    const { service } = setup();
    const { token } = await service.issueForSimulation(B);
    expect(await service.ownerOfValidToken(token)).toBe(B);
  });
});

describe('ProximityService: resolve do código lido (QR ou NFC, ADR 0013)', () => {
  it('[PROX-05] o token de outra pessoa vira o cartão; inexistente e o próprio ficam de fora', async () => {
    const { service } = setup();
    const own = await service.issueToken(viewer(A));
    const other = await service.issueToken(viewer(B));

    expect(await service.resolve(viewer(A), [other.token])).toEqual({
      items: [
        {
          token: other.token,
          handle: 'bia.alves',
          name: 'Bia Alves',
          avatarUrl: 'https://m/avatars/b.jpg',
          alreadyConnected: false,
        },
      ],
    });
    expect(await service.resolve(viewer(A), [UNKNOWN])).toEqual({ items: [] });
    expect(await service.resolve(viewer(A), [own.token])).toEqual({ items: [] });
  });

  it('[PROX-25] vários tokens da mesma pessoa: um cartão só, com o mais recente, na ordem do primeiro', async () => {
    const { service, clock } = setup();
    await service.issueToken(viewer(A));
    const oldB = await service.issueToken(viewer(B));
    const c = await service.issueToken(viewer(C));
    clock.advance(1_000);
    const newB = await service.issueToken(viewer(B));
    const result = await service.resolve(viewer(A), [oldB.token, c.token, newB.token, c.token]);
    expect(result.items.map((item) => [item.handle, item.token, item.alreadyConnected])).toEqual([
      ['bia.alves', newB.token, false],
      ['caio', c.token, true],
    ]);
  });

  it('[PROX-05] vencido (mais de 30 s) e conta escondida pela política não aparecem', async () => {
    const { service, clock, hidden, repository } = setup();
    await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    hidden.add(B);
    expect(await service.resolve(viewer(A), [b.token])).toEqual({ items: [] });
    expect(repository.findNearby).toHaveBeenCalledWith(A, [B], 'filtro-de-bloqueio');
    hidden.clear();
    clock.advance(30_000);
    await service.issueToken(viewer(A));
    expect(await service.resolve(viewer(A), [b.token])).toEqual({ items: [] });
  });

  it('[PROX-04] resolve exige a tela aberta de quem chama', async () => {
    const { service } = setup();
    const other = await service.issueToken(viewer(B));
    expect(await codeOf(service.resolve(viewer(A), [other.token]))).toBe(
      ErrorCode.PROXIMITY_SCREEN_CLOSED,
    );
  });

  it('[PROX-20] 30 resolves por minuto; o 31º dá 429', async () => {
    const { service } = setup();
    await service.issueToken(viewer(A));
    for (let index = 0; index < PROXIMITY_LIMITS.resolve.limit; index++) {
      await service.resolve(viewer(A), [UNKNOWN]);
    }
    expect(await codeOf(service.resolve(viewer(A), [UNKNOWN]))).toBe(ErrorCode.RATE_LIMITED);
  });
});

describe('ProximityService: falhas, bloqueio e fail-closed', () => {
  it('[PROX-20] 20 falhas de token em 10 min bloqueiam a proximidade por 15 min (429)', async () => {
    const { service, clock } = setup();
    for (let index = 0; index < PROXIMITY_LIMITS.failures.limit; index++) {
      await service.recordFailure(viewer(A));
    }
    expect(await codeOf(service.issueToken(viewer(A)))).toBe(ErrorCode.RATE_LIMITED);
    clock.advance(15 * 60_000);
    expect(await codeOf(service.issueToken(viewer(A)))).toBe('ok');
  });

  it('[PROX-21] Redis fora em qualquer passo: 503 PROXIMITY_UNAVAILABLE', async () => {
    for (const name of ['lockRemainingMs', 'hit', 'issue']) {
      const { service, store } = setup();
      store.failing.add(name);
      expect(await codeOf(service.issueToken(viewer(A)))).toBe(ErrorCode.PROXIMITY_UNAVAILABLE);
    }
    for (const name of ['isScreenOpen', 'findValid']) {
      const { service, store } = setup();
      await service.issueToken(viewer(A));
      store.failing.add(name);
      expect(await codeOf(service.resolve(viewer(A), [UNKNOWN]))).toBe(
        ErrorCode.PROXIMITY_UNAVAILABLE,
      );
    }
    const { service, store } = setup();
    store.failing.add('findRecent');
    expect(await codeOf(service.ownerOfRecentToken(UNKNOWN))).toBe(ErrorCode.PROXIMITY_UNAVAILABLE);
  });

  it('[PROX-27] revokeQuietly invalida os tokens; sem Redis, não lança', async () => {
    const { service, store } = setup();
    const { token } = await service.issueToken(viewer(A));
    await service.revokeQuietly(A);
    expect(await service.ownerOfRecentToken(token)).toBeNull();
    store.failing.add('revokeUser');
    await expect(service.revokeQuietly(A)).resolves.toBeUndefined();
  });
});
