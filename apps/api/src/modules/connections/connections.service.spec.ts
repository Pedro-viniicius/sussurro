import type { ConnectionRequestRow } from '@sussurro/db';
import {
  type CreateConnectionRequest,
  ErrorCode,
  ProximityTokenValueSchema,
} from '@sussurro/shared';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectionsRepository } from './connections.repository.js';
import { ConnectionsService } from './connections.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import type { DomainError } from '../../common/errors/domain-error.js';
import { AppConfig } from '../../config/config.module.js';
import { FakeClock } from '../../testing/fake-clock.js';
import { testEnv } from '../../testing/test-env.js';
import type { MediaService } from '../media/media.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { AccessPolicyService } from '../policies/access-policy.service.js';
import { hashProximityToken } from '../proximity/proximity-token.js';
import type { NearbyRow, ProximityRepository } from '../proximity/proximity.repository.js';
import { ProximityService } from '../proximity/proximity.service.js';
import { MemoryProximityStore } from '../proximity/proximity.store.js';
import type { ProfileRow } from '../users/profile.mapper.js';
import type { UsersService } from '../users/users.service.js';

const A = '01a189e0-af57-7000-85fe-2054e618fe0a';
const B = '01a189e0-af57-7000-85fe-2054e618fe0b';
const C = '01a189e0-af57-7000-85fe-2054e618fe0c';
const UNKNOWN = 'AAAAAAAAAAAAAAAA';

const HANDLES: Record<string, string> = { [A]: 'ana', [B]: 'lucasf', [C]: 'caio' };

function viewer(userId: string): AuthContext {
  return { userId, accountType: 'personal', familyId: 'f', emailVerified: true };
}

function profile(id: string): ProfileRow {
  return {
    id,
    email: `${HANDLES[id]}@exemplo.com`,
    handle: HANDLES[id]!,
    name: HANDLES[id]!,
    bio: null,
    avatarKey: null,
    accountType: 'personal',
    emailVerifiedAt: new Date(0),
    createdAt: new Date(0),
  };
}

/**
 * O serviço de conexões com o `ProximityService` de verdade sobre o store em memória (validades
 * no `FakeClock`) e o banco dublado: os pedidos ficam num `Map`.
 */
function setup() {
  const clock = new FakeClock();
  const store = new MemoryProximityStore(clock);
  const config = new AppConfig(testEnv());
  const nearby = {
    findNearby: vi.fn((_viewerId: string, ids: readonly string[]) =>
      Promise.resolve(
        ids.map((id): NearbyRow => ({
          id,
          handle: HANDLES[id]!,
          name: HANDLES[id]!,
          avatarKey: null,
          connected: false,
        })),
      ),
    ),
  };
  const policy = {
    hideBlockedFor: vi.fn(() => 'filtro-de-bloqueio'),
    connectionRequestState: vi.fn(() => Promise.resolve('allowed' as const)),
  };
  const media = { signUrl: vi.fn(() => Promise.resolve(null)) };
  const proximity = new ProximityService(
    store,
    nearby as unknown as ProximityRepository,
    policy as unknown as AccessPolicyService,
    media as unknown as MediaService,
    clock,
    config,
  );

  const requests = new Map<string, ConnectionRequestRow>();
  let sequence = 0;
  const tx = { execute: vi.fn(() => Promise.resolve({ rows: [] })) };
  const repository = {
    db: { transaction: vi.fn((work: (executor: typeof tx) => Promise<unknown>) => work(tx)) },
    expireStaleBetween: vi.fn(() => Promise.resolve()),
    declinedSince: vi.fn(() => Promise.resolve(false)),
    findPending: vi.fn((_tx: unknown, fromId: string, toId: string) =>
      Promise.resolve(
        [...requests.values()].find(
          (row) => row.fromId === fromId && row.toId === toId && row.status === 'pending',
        ),
      ),
    ),
    insertPending: vi.fn(
      (
        _tx: unknown,
        input: {
          fromId: string;
          toId: string;
          method: ConnectionRequestRow['method'];
          now: Date;
          expiresAt: Date;
        },
      ) => {
        sequence += 1;
        const row: ConnectionRequestRow = {
          id: `01a189e0-af57-7000-85fe-${String(sequence).padStart(12, '0')}`,
          fromId: input.fromId,
          fromType: 'personal',
          toId: input.toId,
          toType: 'personal',
          status: 'pending',
          method: input.method,
          createdAt: input.now,
          expiresAt: input.expiresAt,
          respondedAt: null,
        };
        requests.set(row.id, row);
        return Promise.resolve(row);
      },
    ),
    insertConnection: vi.fn(() => Promise.resolve(true)),
    close: vi.fn((_tx: unknown, id: string, status: ConnectionRequestRow['status'], now: Date) => {
      const row = requests.get(id);
      if (row !== undefined) {
        row.status = status;
        row.respondedAt = now;
      }
      return Promise.resolve(row);
    }),
    findForParty: vi.fn((id: string, viewerId: string) => {
      const row = requests.get(id);
      if (row === undefined || (row.fromId !== viewerId && row.toId !== viewerId)) {
        return Promise.resolve(undefined);
      }
      const otherId = row.fromId === viewerId ? row.toId : row.fromId;
      return Promise.resolve({
        request: { ...row },
        other: { id: otherId, handle: HANDLES[otherId]!, name: HANDLES[otherId]!, avatarKey: null },
      });
    }),
    lockRequest: vi.fn((_tx: unknown, id: string) => Promise.resolve(requests.get(id))),
  };
  const users = {
    findActiveAccountById: vi.fn((id: string) =>
      Promise.resolve(id in HANDLES ? profile(id) : undefined),
    ),
    findActiveAccount: vi.fn((handle: string) => {
      const id = Object.keys(HANDLES).find((key) => HANDLES[key] === handle);
      return Promise.resolve(id === undefined ? undefined : profile(id));
    }),
  };
  const notifications = {
    notifyConnectionRequest: vi.fn(() => Promise.resolve()),
    dispatch: vi.fn(() => Promise.resolve()),
    recordConnection: vi.fn(() => Promise.resolve([])),
  };
  const service = new ConnectionsService(
    repository as unknown as ConnectionsRepository,
    proximity,
    users as unknown as UsersService,
    policy as unknown as AccessPolicyService,
    media as unknown as MediaService,
    notifications as unknown as NotificationsService,
    clock,
    config,
  );
  const failures = vi.spyOn(proximity, 'recordFailure');
  return { clock, store, proximity, repository, requests, service, failures };
}

type Setup = ReturnType<typeof setup>;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as DomainError).code;
  }
  return 'ok';
}

/** A e B com a tela aberta. Devolve os tokens dos dois. */
async function opened({ proximity }: Setup) {
  const a = await proximity.issueToken(viewer(A));
  const b = await proximity.issueToken(viewer(B));
  return { a, b };
}

function create(t: Setup, who: string, input: CreateConnectionRequest) {
  return t.service.createRequest(viewer(who), input);
}

const METHODS = ['qr', 'nfc'] as const;

describe('ConnectionsService: pedido por QR ou NFC (ADR 0013 §2: as mesmas regras)', () => {
  it.each(METHODS)(
    '[PROX-06] [PROX-22] %s: com o token válido de B, 201 pending e o método gravado',
    async (method) => {
      const t = setup();
      const { b } = await opened(t);
      const result = await create(t, A, { targetToken: b.token, method });
      expect(result.created).toBe(true);
      expect(result.request).toMatchObject({ status: 'pending', method, direction: 'outgoing' });
      expect(t.repository.insertPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method }),
      );
    },
  );

  it.each(METHODS)('[PROX-02] %s: o token só vale até 30 s para pedir', async (method) => {
    const t = setup();
    const b = await t.proximity.issueToken(viewer(B));
    t.clock.advance(30_000);
    await t.proximity.issueToken(viewer(A));
    expect(await codeOf(create(t, A, { targetToken: b.token, method }))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(t.failures).toHaveBeenCalledTimes(1);
  });

  it.each(METHODS)(
    '[PROX-07] %s: o próprio token → CANNOT_CONNECT_SELF; inexistente → 400 genérico',
    async (method) => {
      const t = setup();
      const { a } = await opened(t);
      expect(await codeOf(create(t, A, { targetToken: a.token, method }))).toBe(
        ErrorCode.CANNOT_CONNECT_SELF,
      );
      expect(await codeOf(create(t, A, { targetToken: UNKNOWN, method }))).toBe(
        ErrorCode.PROXIMITY_TOKEN_INVALID,
      );
    },
  );

  it('[PROX-04] pedido sem a tela aberta de quem pede: 409', async () => {
    const t = setup();
    const b = await t.proximity.issueToken(viewer(B));
    expect(await codeOf(create(t, A, { targetToken: b.token, method: 'nfc' }))).toBe(
      ErrorCode.PROXIMITY_SCREEN_CLOSED,
    );
  });

  it('[PROX-13] os dois tocam em Conectar: o segundo pedido vira conexão na hora, com o método do primeiro', async () => {
    const t = setup();
    const { a, b } = await opened(t);
    await create(t, A, { targetToken: b.token, method: 'nfc' });
    const second = await create(t, B, { targetToken: a.token, method: 'qr' });
    expect(second.request).toMatchObject({ status: 'accepted', method: 'nfc' });
    expect(t.repository.insertConnection).toHaveBeenCalledWith(
      expect.anything(),
      B,
      A,
      expect.objectContaining({ method: 'nfc' }),
    );
  });
});

describe('ConnectionsService: aceite com leitura cruzada nos dois métodos (D7, ADR 0013 §2)', () => {
  async function pending(t: Setup, method: 'qr' | 'nfc') {
    const { a, b } = await opened(t);
    const { request } = await create(t, A, { targetToken: b.token, method });
    return { a, b, id: request.id };
  }

  it.each(METHODS)('[PROX-09] %s: com o token de A lido por B → conectado', async (method) => {
    const t = setup();
    const { a, id } = await pending(t, method);
    const accepted = await t.service.accept(viewer(B), id, a.token);
    expect(accepted).toMatchObject({ direction: 'incoming', status: 'accepted', method });
    expect(t.repository.insertConnection).toHaveBeenCalledWith(
      expect.anything(),
      A,
      B,
      expect.objectContaining({ method }),
    );
  });

  it.each(METHODS)(
    '[PROX-41] %s: token de outra pessoa (C) ou inexistente → 400 genérico, contado como falha; o pedido segue pendente',
    async (method) => {
      const t = setup();
      const { a, id } = await pending(t, method);
      const c = await t.proximity.issueToken(viewer(C));
      await t.proximity.issueToken(viewer(B));
      for (const wrong of [c.token, UNKNOWN]) {
        expect(await codeOf(t.service.accept(viewer(B), id, wrong))).toBe(
          ErrorCode.PROXIMITY_TOKEN_INVALID,
        );
      }
      expect(t.failures).toHaveBeenCalledTimes(2);
      expect(t.requests.get(id)?.status).toBe('pending');
      expect(t.repository.insertConnection).not.toHaveBeenCalled();
      expect((await t.service.accept(viewer(B), id, a.token)).status).toBe('accepted');
    },
  );

  it.each(METHODS)(
    '[PROX-03] %s: o token de A ainda confirma até 120 s depois de emitido; depois, 400 genérico',
    async (method) => {
      const t = setup();
      const { a, id } = await pending(t, method);
      t.clock.advance(100_000);
      await t.proximity.issueToken(viewer(B));
      expect((await t.service.accept(viewer(B), id, a.token)).status).toBe('accepted');

      // O token de A foi emitido 20 s antes do pedido: vence (120 s) antes do pedido (140 s).
      const late = setup();
      const old = await late.proximity.issueToken(viewer(A));
      late.clock.advance(20_000);
      await late.proximity.issueToken(viewer(A));
      const b = await late.proximity.issueToken(viewer(B));
      const { request } = await create(late, A, { targetToken: b.token, method });
      late.clock.advance(99_000);
      await late.proximity.issueToken(viewer(B));
      late.clock.advance(1_000);
      expect(await codeOf(late.service.accept(viewer(B), request.id, old.token))).toBe(
        ErrorCode.PROXIMITY_TOKEN_INVALID,
      );
      expect(late.requests.get(request.id)?.status).toBe('pending');
    },
  );

  it('[PROX-10] o aceite exige a tela aberta de B', async () => {
    const t = setup();
    const { a, id } = await pending(t, 'nfc');
    t.clock.advance(30_000);
    expect(await codeOf(t.service.accept(viewer(B), id, a.token))).toBe(
      ErrorCode.PROXIMITY_SCREEN_CLOSED,
    );
  });

  it('[PROX-12] terceiro ou quem pediu aceitando: o 404 de inexistente', async () => {
    const t = setup();
    const { a, id } = await pending(t, 'nfc');
    await t.proximity.issueToken(viewer(C));
    expect(await codeOf(t.service.accept(viewer(C), id, a.token))).toBe(ErrorCode.NOT_FOUND);
    expect(await codeOf(t.service.accept(viewer(A), id, a.token))).toBe(ErrorCode.NOT_FOUND);
  });

  it('[PROX-11] aceitar de novo devolve o mesmo resultado', async () => {
    const t = setup();
    const { a, id } = await pending(t, 'qr');
    const first = await t.service.accept(viewer(B), id, a.token);
    expect(await t.service.accept(viewer(B), id, a.token)).toEqual(first);
    expect(t.repository.insertConnection).toHaveBeenCalledTimes(1);
  });

  it('[PROX-22] pedido antigo `ble` (ADR 0012, histórico): sai como `nfc`, exige o token e a conexão nasce `nfc`', async () => {
    const t = setup();
    const { a, id } = await pending(t, 'qr');
    t.requests.get(id)!.method = 'ble';
    expect((await t.service.get(viewer(B), id)).method).toBe('nfc');
    const accepted = await t.service.accept(viewer(B), id, a.token);
    expect(accepted.method).toBe('nfc');
    expect(t.repository.insertConnection).toHaveBeenCalledWith(
      expect.anything(),
      A,
      B,
      expect.objectContaining({ method: 'nfc' }),
    );
  });
});

describe('ConnectionsService: simulação em desenvolvimento (D15)', () => {
  it('[PROX-30] [PROX-42] simulate-request sem método: `qr`, e devolve o token da persona, que aceita o pedido', async () => {
    const t = setup();
    await t.proximity.issueToken(viewer(A));
    const result = await t.service.simulateIncoming(viewer(A), 'lucasf', undefined);
    expect(result.request).toMatchObject({
      direction: 'incoming',
      method: 'qr',
      status: 'pending',
    });
    expect(ProximityTokenValueSchema.safeParse(result.observedToken).success).toBe(true);
    expect(await t.store.findValid([hashProximityToken(result.observedToken)])).toEqual([
      expect.objectContaining({ userId: B }),
    ]);
    expect(
      (await t.service.accept(viewer(A), result.request.id, result.observedToken)).status,
    ).toBe('accepted');
  });

  it('[PROX-30] simulate-request nfc: o pedido sai com o método nfc', async () => {
    const t = setup();
    await t.proximity.issueToken(viewer(A));
    const result = await t.service.simulateIncoming(viewer(A), 'lucasf', 'nfc');
    expect(result.request.method).toBe('nfc');
  });

  it('[PROX-42] simulate-request: persona fora da lista → 400; a própria conta → CANNOT_CONNECT_SELF', async () => {
    const t = setup();
    expect(await codeOf(t.service.simulateIncoming(viewer(A), 'caio', undefined))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(await codeOf(t.service.simulateIncoming(viewer(B), undefined, undefined))).toBe(
      ErrorCode.CANNOT_CONNECT_SELF,
    );
  });
});
