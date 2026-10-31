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
import { type AccessPolicyService, touchRevealParties } from '../policies/access-policy.service.js';
import { hashProximityToken } from '../proximity/proximity-token.js';
import type {
  NearbyRow,
  ProximityRepository,
  TouchPairRow,
} from '../proximity/proximity.repository.js';
import { ProximityService } from '../proximity/proximity.service.js';
import { MemoryProximityStore, proximityKeys } from '../proximity/proximity.store.js';
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
 * O serviço de conexões com o `ProximityService` de verdade sobre o store em memória (canal, par e
 * validades no `FakeClock`) e o banco dublado: os pedidos ficam num `Map`.
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
    // (ADR 0012, A3-1) O encosto: as duas contas, pessoais, ativas e sem bloqueio.
    findTouchPair: vi.fn((viewerId: string, ownerId: string) =>
      Promise.resolve(
        [viewerId, ownerId].map((id): TouchPairRow => ({
          id,
          handle: HANDLES[id]!,
          name: HANDLES[id]!,
          avatarKey: null,
          personal: true,
          active: true,
          connected: false,
          blocked: false,
        })),
      ),
    ),
  };
  const policy = {
    hideBlockedFor: vi.fn(() => 'filtro-de-bloqueio'),
    touchRevealParties: vi.fn(touchRevealParties),
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
        input: { fromId: string; toId: string; method: 'ble' | 'qr'; now: Date; expiresAt: Date },
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

/** A e B com a tela aberta e o encosto mútuo: o par vale 60 s. Devolve os tokens dos dois. */
async function touched({ proximity }: Setup) {
  const a = await proximity.issueToken(viewer(A));
  const b = await proximity.issueToken(viewer(B));
  await proximity.touches(viewer(A), [b.bleToken]);
  await proximity.touches(viewer(B), [a.bleToken]);
  return { a, b };
}

function create(t: Setup, who: string, input: CreateConnectionRequest) {
  return t.service.createRequest(viewer(who), input);
}

describe('ConnectionsService: pedido por encostar (ADR 0012 §4)', () => {
  it('[PROX-06] com o par encostado e o bleToken de B: 201 pending, method ble', async () => {
    const t = setup();
    const { b } = await touched(t);
    const result = await create(t, A, { targetToken: b.bleToken, method: 'ble' });
    expect(result.created).toBe(true);
    expect(result.request).toMatchObject({
      direction: 'outgoing',
      status: 'pending',
      method: 'ble',
    });
    expect(t.failures).not.toHaveBeenCalled();
  });

  it('[PROX-32] sem o par (o bleToken lido do ar, sem encosto mútuo): 400 genérico, contado como falha', async () => {
    const t = setup();
    await t.proximity.issueToken(viewer(A));
    const b = await t.proximity.issueToken(viewer(B));
    // Só A relatou: não há par.
    await t.proximity.touches(viewer(A), [b.bleToken]);
    expect(await codeOf(create(t, A, { targetToken: b.bleToken, method: 'ble' }))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(t.failures).toHaveBeenCalledTimes(1);
    expect(t.repository.insertPending).not.toHaveBeenCalled();
  });

  it('[PROX-39] o token "recente" basta enquanto o par vale (o app só conhece o token do casamento)', async () => {
    const t = setup();
    const { b } = await touched(t);
    t.clock.advance(45_000);
    await t.proximity.issueToken(viewer(A)); // a tela de A continua aberta
    expect(await t.proximity.ownerOfValidToken(b.bleToken, 'ble')).toBeNull();
    const result = await create(t, A, { targetToken: b.bleToken, method: 'ble' });
    expect(result.request.status).toBe('pending');
  });

  it('[PROX-39] o par vencido (60 s) devolve o mesmo 400 genérico, contado como falha', async () => {
    const t = setup();
    const { b } = await touched(t);
    t.clock.advance(60_000);
    await t.proximity.issueToken(viewer(A));
    expect(await codeOf(create(t, A, { targetToken: b.bleToken, method: 'ble' }))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(t.failures).toHaveBeenCalledTimes(1);
  });

  it('[PROX-39] token de outra pessoa (C), com o par A–B valendo: 400 genérico (o par é do dono do token)', async () => {
    const t = setup();
    await touched(t);
    const c = await t.proximity.issueToken(viewer(C));
    expect(await codeOf(create(t, A, { targetToken: c.bleToken, method: 'ble' }))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(t.failures).toHaveBeenCalledTimes(1);
  });

  it('[PROX-39] [PROX-40] canal trocado: o qrToken no pedido ble e o bleToken no pedido qr dão 400 genérico, contado como falha', async () => {
    const t = setup();
    const { b } = await touched(t);
    expect(await codeOf(create(t, A, { targetToken: b.qrToken, method: 'ble' }))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(await codeOf(create(t, A, { targetToken: b.bleToken, method: 'qr' }))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(t.failures).toHaveBeenCalledTimes(2);
    expect(t.repository.insertPending).not.toHaveBeenCalled();
  });

  it('[PROX-07] o próprio token no canal certo: CANNOT_CONNECT_SELF; no canal trocado, o 400 genérico', async () => {
    const t = setup();
    const { a } = await touched(t);
    expect(await codeOf(create(t, A, { targetToken: a.bleToken, method: 'ble' }))).toBe(
      ErrorCode.CANNOT_CONNECT_SELF,
    );
    expect(await codeOf(create(t, A, { targetToken: a.qrToken, method: 'qr' }))).toBe(
      ErrorCode.CANNOT_CONNECT_SELF,
    );
    expect(await codeOf(create(t, A, { targetToken: a.qrToken, method: 'ble' }))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(t.failures).toHaveBeenCalledTimes(1);
  });

  it('[PROX-04] pedido sem a tela aberta de quem pede: 409', async () => {
    const t = setup();
    const { b } = await touched(t);
    t.clock.advance(30_000);
    expect(await codeOf(create(t, A, { targetToken: b.bleToken, method: 'ble' }))).toBe(
      ErrorCode.PROXIMITY_SCREEN_CLOSED,
    );
  });

  it('[PROX-13] os dois tocam em Conectar: o segundo pedido vira conexão na hora (P5)', async () => {
    const t = setup();
    const { a, b } = await touched(t);
    await create(t, A, { targetToken: b.bleToken, method: 'ble' });
    const second = await create(t, B, { targetToken: a.bleToken, method: 'ble' });
    expect(second.created).toBe(false);
    expect(second.request).toMatchObject({ status: 'accepted', method: 'ble' });
    expect(t.repository.insertConnection).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionsService: pedido por QR (D7, ADR 0012 §5)', () => {
  it('[PROX-06] com o qrToken válido de B (sem par): 201 pending, method qr', async () => {
    const t = setup();
    await t.proximity.issueToken(viewer(A));
    const b = await t.proximity.issueToken(viewer(B));
    const result = await create(t, A, { targetToken: b.qrToken, method: 'qr' });
    expect(result.request).toMatchObject({ status: 'pending', method: 'qr' });
  });

  it('[PROX-02] o qrToken só vale até 30 s para pedir', async () => {
    const t = setup();
    const b = await t.proximity.issueToken(viewer(B));
    t.clock.advance(30_000);
    await t.proximity.issueToken(viewer(A));
    expect(await codeOf(create(t, A, { targetToken: b.qrToken, method: 'qr' }))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
  });
});

describe('ConnectionsService: aceite por método (ADR 0012 §4)', () => {
  async function pending(t: Setup, method: 'ble' | 'qr') {
    const { a, b } = await touched(t);
    const { request } = await create(t, A, {
      targetToken: method === 'ble' ? b.bleToken : b.qrToken,
      method,
    });
    return { a, b, id: request.id };
  }

  it('[PROX-09] ble: B aceita sem token e fica conectado', async () => {
    const t = setup();
    const { id } = await pending(t, 'ble');
    const accepted = await t.service.accept(viewer(B), id, undefined);
    expect(accepted).toMatchObject({ direction: 'incoming', status: 'accepted', method: 'ble' });
    expect(t.repository.insertConnection).toHaveBeenCalledTimes(1);
  });

  it('[PROX-09] ble: o observedToken, se vier, é ignorado (nem conta como falha)', async () => {
    const t = setup();
    const { id } = await pending(t, 'ble');
    const accepted = await t.service.accept(viewer(B), id, UNKNOWN);
    expect(accepted.status).toBe('accepted');
    expect(t.failures).not.toHaveBeenCalled();
  });

  it('[PROX-10] ble: o aceite continua exigindo a tela aberta de B', async () => {
    const t = setup();
    const { id } = await pending(t, 'ble');
    t.clock.advance(30_000);
    expect(await codeOf(t.service.accept(viewer(B), id, undefined))).toBe(
      ErrorCode.PROXIMITY_SCREEN_CLOSED,
    );
  });

  it('[PROX-41] ble: o aceite não depende do par (P4): com o par vencido, ainda aceita dentro dos 120 s do pedido', async () => {
    const t = setup();
    const { id } = await pending(t, 'ble');
    t.clock.advance(90_000);
    await t.proximity.issueToken(viewer(B));
    expect(await t.proximity.hasTouchPair(A, B)).toBe(false);
    expect((await t.service.accept(viewer(B), id, undefined)).status).toBe('accepted');
  });

  it('[PROX-09] qr: sem observedToken → 400 VALIDATION_ERROR, sem contar falha, e o pedido segue pendente', async () => {
    const t = setup();
    const { id } = await pending(t, 'qr');
    expect(await codeOf(t.service.accept(viewer(B), id, undefined))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(t.failures).not.toHaveBeenCalled();
    expect(t.requests.get(id)?.status).toBe('pending');
  });

  it('[PROX-09] qr: com o qrToken de A lido do QR → conectado', async () => {
    const t = setup();
    const { a, id } = await pending(t, 'qr');
    expect((await t.service.accept(viewer(B), id, a.qrToken)).status).toBe('accepted');
  });

  it('[PROX-03] qr: o qrToken de A ainda confirma até 120 s; depois, 400 genérico', async () => {
    const t = setup();
    const { a, id } = await pending(t, 'qr');
    t.clock.advance(100_000);
    await t.proximity.issueToken(viewer(B));
    expect((await t.service.accept(viewer(B), id, a.qrToken)).status).toBe('accepted');

    // O token de A foi emitido 20 s antes do pedido: vence (120 s) antes do pedido (140 s).
    const late = setup();
    const old = await late.proximity.issueToken(viewer(A));
    late.clock.advance(20_000);
    await late.proximity.issueToken(viewer(A));
    const b = await late.proximity.issueToken(viewer(B));
    const { request } = await create(late, A, { targetToken: b.qrToken, method: 'qr' });
    late.clock.advance(99_000);
    await late.proximity.issueToken(viewer(B));
    late.clock.advance(1_000);
    expect(await codeOf(late.service.accept(viewer(B), request.id, old.qrToken))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(late.requests.get(request.id)?.status).toBe('pending');
  });

  it('[PROX-41] qr: o bleToken de A (canal trocado) ou o qrToken de C → 400 genérico, contado como falha; o pedido segue pendente', async () => {
    const t = setup();
    const { a, id } = await pending(t, 'qr');
    const c = await t.proximity.issueToken(viewer(C));
    expect(await codeOf(t.service.accept(viewer(B), id, a.bleToken))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(await codeOf(t.service.accept(viewer(B), id, c.qrToken))).toBe(
      ErrorCode.PROXIMITY_TOKEN_INVALID,
    );
    expect(t.failures).toHaveBeenCalledTimes(2);
    expect(t.requests.get(id)?.status).toBe('pending');
    expect(t.repository.insertConnection).not.toHaveBeenCalled();
    expect((await t.service.accept(viewer(B), id, a.qrToken)).status).toBe('accepted');
  });

  it('[PROX-12] terceiro aceitando um pedido qr sem token: o 404 de inexistente (não descobre o método)', async () => {
    const t = setup();
    const { id } = await pending(t, 'qr');
    await t.proximity.issueToken(viewer(C));
    expect(await codeOf(t.service.accept(viewer(C), id, undefined))).toBe(ErrorCode.NOT_FOUND);
    // E quem pediu também não aceita o próprio pedido.
    expect(await codeOf(t.service.accept(viewer(A), id, undefined))).toBe(ErrorCode.NOT_FOUND);
  });

  it('[PROX-11] aceitar de novo devolve o mesmo resultado (ble sem token)', async () => {
    const t = setup();
    const { id } = await pending(t, 'ble');
    const first = await t.service.accept(viewer(B), id, undefined);
    expect(await t.service.accept(viewer(B), id, undefined)).toEqual(first);
    expect(t.repository.insertConnection).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionsService: simulação em desenvolvimento (D15, ADR 0012 §7)', () => {
  it('[PROX-30] [PROX-42] simulate-request ble: grava o par da persona e devolve o qrToken dela', async () => {
    const t = setup();
    await t.proximity.issueToken(viewer(A));
    const result = await t.service.simulateIncoming(viewer(A), 'lucasf', undefined);
    expect(result.request).toMatchObject({
      direction: 'incoming',
      method: 'ble',
      status: 'pending',
    });
    expect(ProximityTokenValueSchema.safeParse(result.observedToken).success).toBe(true);
    expect(await t.store.findValid([hashProximityToken(result.observedToken)])).toEqual([
      expect.objectContaining({ userId: B, channel: 'qr' }),
    ]);
    expect(await t.proximity.hasTouchPair(A, B)).toBe(true);
    // O aceite ble dispensa o token.
    expect((await t.service.accept(viewer(A), result.request.id, undefined)).status).toBe(
      'accepted',
    );
  });

  it('[PROX-30] simulate-request qr: sem par; o qrToken devolvido aceita o pedido', async () => {
    const t = setup();
    await t.proximity.issueToken(viewer(A));
    const result = await t.service.simulateIncoming(viewer(A), 'lucasf', 'qr');
    expect(result.request.method).toBe('qr');
    expect(await t.proximity.hasTouchPair(A, B)).toBe(false);
    expect(
      (await t.service.accept(viewer(A), result.request.id, result.observedToken)).status,
    ).toBe('accepted');
  });

  it('[PROX-42] simulate-touch: grava a observação da persona e devolve o bleToken; o relato da conta fecha o casamento', async () => {
    const t = setup();
    await t.proximity.issueToken(viewer(A));
    const { bleToken } = await t.service.simulateTouch(viewer(A), '@lucasf');
    expect(await t.store.findValid([hashProximityToken(bleToken)])).toEqual([
      expect.objectContaining({ userId: B, channel: 'ble' }),
    ]);
    expect(t.store.entries().map((entry) => entry.key)).toContain(proximityKeys.touch(B, A));
    const card = await t.proximity.touches(viewer(A), [bleToken]);
    expect(card.items).toEqual([expect.objectContaining({ token: bleToken, handle: 'lucasf' })]);
    // Com o par, a conta pode tocar em "Conectar" com a persona.
    const request = await create(t, A, { targetToken: bleToken, method: 'ble' });
    expect(request.request.status).toBe('pending');
  });

  it('[PROX-42] simulate-touch: persona fora da lista → 400; a própria conta → CANNOT_CONNECT_SELF', async () => {
    const t = setup();
    expect(await codeOf(t.service.simulateTouch(viewer(A), 'caio'))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(await codeOf(t.service.simulateTouch(viewer(B), undefined))).toBe(
      ErrorCode.CANNOT_CONNECT_SELF,
    );
  });
});
