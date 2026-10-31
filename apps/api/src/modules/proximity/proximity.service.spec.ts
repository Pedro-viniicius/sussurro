import { Logger } from '@nestjs/common';
import {
  ErrorCode,
  PROXIMITY_TOUCH_LIMIT_PER_MIN,
  ProximityTokenSchema,
  ProximityTokenValueSchema,
  ProximityTouchResultSchema,
} from '@sussurro/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashProximityToken, PROXIMITY_LIMITS } from './proximity-token.js';
import type { NearbyRow, ProximityRepository, TouchPairRow } from './proximity.repository.js';
import { PROXIMITY_TOUCH_CAPPED, ProximityService } from './proximity.service.js';
import {
  type BlockSignalCounts,
  MemoryProximityStore,
  proximityKeys,
  type TouchClaim,
} from './proximity.store.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import type { DomainError } from '../../common/errors/domain-error.js';
import { AppConfig } from '../../config/config.module.js';
import { FakeClock } from '../../testing/fake-clock.js';
import { testEnv } from '../../testing/test-env.js';
import type { MediaService } from '../media/media.service.js';
import { type AccessPolicyService, touchRevealParties } from '../policies/access-policy.service.js';

const A = '01a189e0-af57-7000-85fe-2054e618fe0a';
const B = '01a189e0-af57-7000-85fe-2054e618fe0b';
const C = '01a189e0-af57-7000-85fe-2054e618fe0c';
const D = '01a189e0-af57-7000-85fe-2054e618fe0d';
const E = '01a189e0-af57-7000-85fe-2054e618fe0e';
const F = '01a189e0-af57-7000-85fe-2054e618fe0f';
const G = '01a189e0-af57-7000-85fe-2054e618fe10';
const UNKNOWN = 'AAAAAAAAAAAAAAAA';
const SECOND = 1_000;
const HOUR = 3_600_000;

function viewer(userId: string): AuthContext {
  return { userId, accountType: 'personal', familyId: 'f', emailVerified: true };
}

/** O que o cartão mostra de cada conta (a conexão e a política ficam em `facts`, no `setup`). */
type Person = Omit<NearbyRow, 'connected'>;

const PEOPLE: Record<string, Person> = {
  [A]: { id: A, handle: 'ana', name: 'Ana', avatarKey: null },
  [B]: { id: B, handle: 'bia.alves', name: 'Bia Alves', avatarKey: 'avatars/b.jpg' },
  [C]: { id: C, handle: 'caio', name: 'Caio', avatarKey: null },
  [D]: { id: D, handle: 'duda', name: 'Duda', avatarKey: null },
  [E]: { id: E, handle: 'enzo', name: 'Enzo', avatarKey: null },
  // (PROX-66) Valores que não aparecem por acaso num texto: o teste de vazamento procura por eles.
  [F]: {
    id: F,
    handle: 'fabio.sigiloso',
    name: 'Fábio Sigiloso',
    avatarKey: 'avatars/fabio-sigiloso.jpg',
  },
  [G]: {
    id: G,
    handle: 'gina.reservada',
    name: 'Gina Reservada',
    avatarKey: 'avatars/gina-reservada.jpg',
  },
};

/** Chave do par sem ordem (a conexão). */
function pairOf(first: string, second: string): string {
  return [first, second].sort().join('|');
}

/**
 * Store em memória em que cada operação pode falhar (Redis fora no meio, PROX-21, PROX-54) e que
 * registra, na ordem, cada operação da porta que chegou a ele (`calls`; o `findTouchPair` e o
 * `findNearby` do repositório entram na mesma lista), para o teste de sequência do A3-1 (PROX-66).
 */
class SwitchableStore extends MemoryProximityStore {
  readonly failing = new Set<string>();
  readonly calls: string[] = [];

  private outage<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.calls.push(name);
    return this.failing.has(name) ? Promise.reject(new Error(`fora: ${name}`)) : operation();
  }

  override issue(...args: Parameters<MemoryProximityStore['issue']>) {
    return this.outage('issue', () => super.issue(...args));
  }

  override findValid(...args: Parameters<MemoryProximityStore['findValid']>) {
    return this.outage('findValid', () => super.findValid(...args));
  }

  override isScreenOpen(...args: Parameters<MemoryProximityStore['isScreenOpen']>) {
    return this.outage('isScreenOpen', () => super.isScreenOpen(...args));
  }

  override revokeUser(...args: Parameters<MemoryProximityStore['revokeUser']>) {
    return this.outage('revokeUser', () => super.revokeUser(...args));
  }

  override lock(...args: Parameters<MemoryProximityStore['lock']>) {
    return this.outage('lock', () => super.lock(...args));
  }

  override lockRemainingMs(...args: Parameters<MemoryProximityStore['lockRemainingMs']>) {
    return this.outage('lockRemainingMs', () => super.lockRemainingMs(...args));
  }

  override recordTouch(...args: Parameters<MemoryProximityStore['recordTouch']>) {
    return this.outage('recordTouch', () => super.recordTouch(...args));
  }

  override claimTouchPair(...args: Parameters<MemoryProximityStore['claimTouchPair']>) {
    return this.outage('claimTouchPair', () => super.claimTouchPair(...args));
  }

  override takeOwedCard(...args: Parameters<MemoryProximityStore['takeOwedCard']>) {
    return this.outage('takeOwedCard', () => super.takeOwedCard(...args));
  }

  override markTouchPair(...args: Parameters<MemoryProximityStore['markTouchPair']>) {
    return this.outage('markTouchPair', () => super.markTouchPair(...args));
  }

  override findRecent(...args: Parameters<MemoryProximityStore['findRecent']>) {
    return this.outage('findRecent', () => super.findRecent(...args));
  }

  override hasTouchPair(...args: Parameters<MemoryProximityStore['hasTouchPair']>) {
    return this.outage('hasTouchPair', () => super.hasTouchPair(...args));
  }

  override countBlockSignal(...args: Parameters<MemoryProximityStore['countBlockSignal']>) {
    return this.outage('countBlockSignal', () => super.countBlockSignal(...args));
  }

  override hit(...args: Parameters<MemoryProximityStore['hit']>) {
    return this.outage('hit', () => super.hit(...args));
  }

  override forgetTouchState(...args: Parameters<MemoryProximityStore['forgetTouchState']>) {
    return this.outage('forgetTouchState', () => super.forgetTouchState(...args));
  }
}

function setup(overrides: Record<string, string> = {}) {
  const clock = new FakeClock();
  const store = new SwitchableStore(clock);
  /** O banco dublado: o que a política lê (bloqueio, tipo de conta, exclusão) e as conexões. */
  const facts = {
    /** Bloqueios gravados, `"{quem bloqueou}>{quem foi bloqueado}"`. */
    blocks: new Set<string>(),
    /** Contas de criador. */
    creators: new Set<string>(),
    /** Contas excluídas (`deleted_at` preenchido; a linha continua no banco). */
    deleted: new Set<string>(),
    /** Contas sem linha no banco (apagadas de vez). */
    missing: new Set<string>(),
    /** Pares conectados (`pairOf`). A e C são conexões. */
    connections: new Set<string>([pairOf(A, C)]),
  };
  const blockedBetween = (first: string, second: string) =>
    facts.blocks.has(`${first}>${second}`) || facts.blocks.has(`${second}>${first}`);
  const exists = (id: string) => id in PEOPLE && !facts.missing.has(id);
  const repository = {
    // O QR (`resolve`): a política no `WHERE`, como o SQL (o `visible` é o `hideBlockedFor`).
    findNearby: vi.fn((viewerId: string, ids: readonly string[]): Promise<NearbyRow[]> => {
      store.calls.push('findNearby');
      return Promise.resolve(
        ids
          .filter(
            (id) =>
              exists(id) &&
              !facts.creators.has(id) &&
              !facts.deleted.has(id) &&
              !blockedBetween(viewerId, id),
          )
          .map((id) => ({
            ...PEOPLE[id]!,
            connected: facts.connections.has(pairOf(viewerId, id)),
          })),
      );
    }),
    // (A3-1, R22) O encosto: as duas linhas sempre que as contas existem, com os fatos em colunas,
    // `connected` e `blocked` do par. A ordem das linhas não é garantida (sem `ORDER BY`): por id.
    findTouchPair: vi.fn((viewerId: string, ownerId: string): Promise<TouchPairRow[]> => {
      store.calls.push('findTouchPair');
      return Promise.resolve(
        [viewerId, ownerId]
          .filter(exists)
          .sort()
          .map((id) => ({
            ...PEOPLE[id]!,
            personal: !facts.creators.has(id),
            active: !facts.deleted.has(id),
            connected: facts.connections.has(pairOf(viewerId, ownerId)),
            blocked: blockedBetween(viewerId, ownerId),
          })),
      );
    }),
  };
  // A regra de verdade (pura) do `AccessPolicyService`; o filtro SQL do QR é dublado.
  const policy = {
    hideBlockedFor: vi.fn(() => 'filtro-de-bloqueio'),
    touchRevealParties: vi.fn(touchRevealParties),
  };
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
    new AppConfig(testEnv(overrides)),
  );
  return { clock, store, facts, repository, policy, media, service };
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

function keys(store: MemoryProximityStore): string[] {
  return store.entries().map((entry) => entry.key);
}

/** Valor e prazo de uma chave do fake (A3-2: o prazo do cartão e do ocupado na reentrega). */
function rawEntry(store: MemoryProximityStore, key: string) {
  const entry = (
    store as unknown as { values: Map<string, { value: string; expiresAt: number }> }
  ).values.get(key);
  return entry === undefined ? undefined : { ...entry };
}

const NOTHING = { items: [] };

/**
 * (ADR 0012, A3-1) As idas de um relato com token válido, do canal `ble` e de outra conta, sem
 * cartão devido: as mesmas em todo caminho (não mútuo, recusa, teto, ocupado e casamento).
 */
const TOUCH_PATH = [
  'takeOwedCard',
  'lockRemainingMs',
  'hit',
  'isScreenOpen',
  'findValid',
  'recordTouch',
  'findTouchPair',
  'claimTouchPair',
];

/**
 * Encosto honesto entre `first` (relata primeiro) e `second`: os dois abrem a tela com tokens novos,
 * `first` relata (sem cartão), `second` relata (casa e recebe o cartão de `first`). Devolve os
 * tokens e a resposta de `second`. O cartão de `second` fica devido a `first`.
 */
async function touchPair(t: Setup, first: string, second: string) {
  const firstTokens = await t.service.issueToken(viewer(first));
  const secondTokens = await t.service.issueToken(viewer(second));
  const opening = await t.service.touches(viewer(first), [secondTokens.bleToken]);
  const answer = await t.service.touches(viewer(second), [firstTokens.bleToken]);
  return { firstTokens, secondTokens, opening, answer };
}

interface Refusal {
  name: string;
  refuse: (facts: Setup['facts']) => void;
}

/**
 * (PROX-36, PROX-66) Cada recusa da política entre `first` e `second`, nos dois lados: o bloqueio
 * em cada sentido, a conta excluída, a conta de criador e (defesa) a conta sem linha no banco.
 */
function refusals(first: string, second: string): Refusal[] {
  const sides: [string, string][] = [
    [first, second],
    [second, first],
  ];
  return sides.flatMap(([x, y]): Refusal[] => {
    const [nameX, nameY] = [PEOPLE[x]!.handle, PEOPLE[y]!.handle];
    return [
      { name: `${nameX} bloqueou ${nameY}`, refuse: (f) => f.blocks.add(`${x}>${y}`) },
      { name: `${nameX} excluiu a conta`, refuse: (f) => f.deleted.add(x) },
      { name: `${nameX} é criador`, refuse: (f) => f.creators.add(x) },
      { name: `${nameX} sem linha no banco`, refuse: (f) => f.missing.add(x) },
    ];
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ProximityService: emissão (ADR 0012 §1)', () => {
  it('[PROX-01] cada emissão traz dois tokens distintos, um por canal, gravados só como hash', async () => {
    const { service, store, clock } = setup();
    const issued = await service.issueToken(viewer(A));
    expect(ProximityTokenSchema.parse(issued)).toEqual(issued);
    expect(issued.bleToken).not.toBe(issued.qrToken);
    expect(issued.expiresAt).toBe(new Date(clock.now().getTime() + 30_000).toISOString());
    expect(issued.renewInS).toBe(20);

    const [ble, qr] = await store.findValid([
      hashProximityToken(issued.bleToken),
      hashProximityToken(issued.qrToken),
    ]);
    expect(ble).toEqual({ userId: A, issuedAt: clock.now().getTime(), channel: 'ble' });
    expect(qr).toEqual({ userId: A, issuedAt: clock.now().getTime(), channel: 'qr' });
    expect(await store.isScreenOpen(A)).toBe(true);
    const dump = JSON.stringify(store.entries());
    expect(dump).not.toContain(issued.bleToken);
    expect(dump).not.toContain(issued.qrToken);
  });

  it('[PROX-20] o limite de 6 por minuto conta a emissão (os dois tokens), não cada token', async () => {
    const { service } = setup();
    for (let index = 0; index < PROXIMITY_LIMITS.tokens.limit; index++) {
      await service.issueToken(viewer(A));
    }
    expect(await codeOf(service.issueToken(viewer(A)))).toBe(ErrorCode.RATE_LIMITED);
  });

  it('[PROX-33] [PROX-40] dono pelo canal: o token do outro canal é o mesmo que inexistente', async () => {
    const { service, clock } = setup();
    const { bleToken, qrToken } = await service.issueToken(viewer(A));
    expect(await service.ownerOfValidToken(bleToken, 'ble')).toBe(A);
    expect(await service.ownerOfValidToken(bleToken, 'qr')).toBeNull();
    expect(await service.ownerOfValidToken(qrToken, 'qr')).toBe(A);
    expect(await service.ownerOfValidToken(qrToken, 'ble')).toBeNull();
    clock.advance(31_000);
    expect(await service.ownerOfValidToken(qrToken, 'qr')).toBeNull();
    expect(await service.ownerOfRecentToken(qrToken, 'qr')).toBe(A);
    expect(await service.ownerOfRecentToken(qrToken, 'ble')).toBeNull();
    expect(await service.ownerOfRecentToken(bleToken, 'ble')).toBe(A);
    clock.advance(90_000);
    expect(await service.ownerOfRecentToken(bleToken, 'ble')).toBeNull();
  });
});

describe('ProximityService: resolve só do QR (ADR 0012 §3)', () => {
  it('[PROX-05] o qrToken resolve; o bleToken do mesmo dono não resolve (igual a inexistente)', async () => {
    const { service } = setup();
    const own = await service.issueToken(viewer(A));
    const other = await service.issueToken(viewer(B));

    expect(await service.resolve(viewer(A), [other.qrToken])).toEqual({
      items: [
        {
          token: other.qrToken,
          handle: 'bia.alves',
          name: 'Bia Alves',
          avatarUrl: 'https://m/avatars/b.jpg',
          alreadyConnected: false,
        },
      ],
    });
    expect(await service.resolve(viewer(A), [other.bleToken])).toEqual(NOTHING);
    expect(await service.resolve(viewer(A), [UNKNOWN])).toEqual(NOTHING);
    expect(await service.resolve(viewer(A), [own.qrToken])).toEqual(NOTHING);
  });

  it('[PROX-04] resolve exige a tela aberta de quem chama', async () => {
    const { service } = setup();
    const other = await service.issueToken(viewer(B));
    expect(await codeOf(service.resolve(viewer(A), [other.qrToken]))).toBe(
      ErrorCode.PROXIMITY_SCREEN_CLOSED,
    );
  });
});

describe('ProximityService: touches, a observação mútua (ADR 0012 §3 e A2)', () => {
  it('[PROX-32] revelação simétrica: o primeiro recebe [], o segundo o cartão, o primeiro no relato seguinte (o cartão devido)', async () => {
    const t = setup();
    const a = await t.service.issueToken(viewer(A));
    const b = await t.service.issueToken(viewer(B));

    expect(await t.service.touches(viewer(A), [b.bleToken])).toEqual(NOTHING);
    expect(await t.store.hasTouchPair(A, B)).toBe(false);

    t.clock.advance(800);
    expect(await t.service.touches(viewer(B), [a.bleToken])).toEqual({
      items: [
        {
          token: a.bleToken,
          handle: 'ana',
          name: 'Ana',
          avatarUrl: null,
          alreadyConnected: false,
          pairExpiresInS: 55,
        },
      ],
    });
    expect(await t.store.hasTouchPair(A, B)).toBe(true);
    // A política foi consultada uma vez por relato com token válido de outra conta (A3-1: também
    // no não mútuo), com quem chama e o dono do token, pelo `findTouchPair` (nunca o do QR).
    expect(t.repository.findTouchPair).toHaveBeenCalledTimes(2);
    expect(t.repository.findTouchPair).toHaveBeenNthCalledWith(1, A, B);
    expect(t.repository.findTouchPair).toHaveBeenLastCalledWith(B, A);
    expect(t.repository.findNearby).not.toHaveBeenCalled();
    expect(t.policy.hideBlockedFor).not.toHaveBeenCalled();

    t.clock.advance(1_000);
    expect(await t.service.touches(viewer(A), [b.bleToken])).toEqual({
      items: [
        {
          token: b.bleToken,
          handle: 'bia.alves',
          name: 'Bia Alves',
          avatarUrl: 'https://m/avatars/b.jpg',
          alreadyConnected: false,
          pairExpiresInS: 55,
        },
      ],
    });
    // A entrega do cartão devido não passa de novo pela política.
    expect(t.repository.findTouchPair).toHaveBeenCalledTimes(2);
  });

  it('[PROX-32] sem o relato recíproco na janela de 5 s: a mesma resposta de token inexistente', async () => {
    const { service, store, clock } = setup();
    const a = await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    await service.touches(viewer(A), [b.bleToken]);
    clock.advance(5 * SECOND);
    await service.issueToken(viewer(B)); // a tela de B continua aberta
    const late = await service.touches(viewer(B), [a.bleToken]);
    const unknown = await service.touches(viewer(B), [UNKNOWN]);
    expect(late).toEqual(NOTHING);
    expect(late).toEqual(unknown);
    expect(await store.hasTouchPair(A, B)).toBe(false);
  });

  it('[PROX-32] token do QR, vencido, inexistente ou do próprio chamador: ignorado, sem observação nem cartão', async () => {
    const { service, store, clock } = setup();
    const a = await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    const own = await service.issueToken(viewer(A));

    // B relata A pelo QR (não é o canal do encosto): A relatar B depois não casa.
    await service.touches(viewer(B), [a.qrToken]);
    expect(await service.touches(viewer(A), [b.bleToken])).toEqual(NOTHING);
    expect(keys(store)).not.toContain(proximityKeys.touch(B, A));

    expect(await service.touches(viewer(A), [own.bleToken])).toEqual(NOTHING);
    expect(await service.touches(viewer(A), [UNKNOWN])).toEqual(NOTHING);
    expect(keys(store)).not.toContain(proximityKeys.touch(A, A));

    // Vencido (30 s): o token velho de A não casa com a observação nova de A.
    clock.advance(30 * SECOND);
    const renewedB = await service.issueToken(viewer(B));
    await service.issueToken(viewer(A));
    await service.touches(viewer(A), [renewedB.bleToken]);
    expect(await service.touches(viewer(B), [a.bleToken])).toEqual(NOTHING);
    expect(await store.hasTouchPair(A, B)).toBe(false);
  });

  it('[PROX-38] um token por chamada: só o primeiro conta (o schema já recusa 2)', async () => {
    const { service, store } = setup();
    await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    expect(await service.touches(viewer(A), [UNKNOWN, b.bleToken])).toEqual(NOTHING);
    expect(keys(store)).not.toContain(proximityKeys.touch(A, B));
  });

  it('[PROX-36] [PROX-66] bloqueio em cada sentido, conta excluída, criador e conta sem linha, nos dois lados: sem cartão, sem par e sem cartão devido', async () => {
    for (const { name, refuse } of refusals(A, B)) {
      const t = setup();
      const claims = vi.spyOn(t.store, 'claimTouchPair');
      const firstTokens = await t.service.issueToken(viewer(A));
      const secondTokens = await t.service.issueToken(viewer(B));
      refuse(t.facts);
      expect(await t.service.touches(viewer(A), [secondTokens.bleToken]), name).toEqual(NOTHING);
      expect(await t.service.touches(viewer(B), [firstTokens.bleToken]), name).toEqual(NOTHING);
      expect(await t.service.touches(viewer(A), [secondTokens.bleToken]), name).toEqual(NOTHING);
      expect(await t.service.touches(viewer(B), [firstTokens.bleToken]), name).toEqual(NOTHING);
      expect(await t.store.hasTouchPair(A, B), name).toBe(false);
      expect(keys(t.store), name).not.toContain(proximityKeys.owed(A));
      expect(keys(t.store), name).not.toContain(proximityKeys.owed(B));
      // [PROX-46] A política vem antes do casamento, e o script roda mesmo assim (A3-1), com o
      // cartão nulo: `gone` no primeiro relato (o outro ainda não relatou) e `refused` nos
      // recusados. Par recusado nunca toca os contadores.
      expect(
        await Promise.all(claims.mock.results.map((result) => result.value as Promise<TouchClaim>)),
        name,
      ).toEqual(['gone', 'refused', 'refused', 'refused']);
      expect(
        claims.mock.calls.map(([input]) => input.callerCard),
        name,
      ).toEqual([null, null, null, null]);
      const counters = (t.store as unknown as { counters: Map<string, unknown> }).counters;
      expect(
        [...counters.keys()].filter((key) => key.startsWith('rl:prox-pairs:')),
        name,
      ).toEqual([]);
      // A decisão é a da política (uma vez por relato), sobre as duas linhas; nada do QR.
      expect(t.policy.touchRevealParties, name).toHaveBeenCalledTimes(4);
      expect(t.repository.findTouchPair, name).toHaveBeenCalledTimes(4);
      expect(t.repository.findNearby, name).not.toHaveBeenCalled();
      expect(t.media.signUrl, name).not.toHaveBeenCalled();
    }
  });

  it('[PROX-66] [PROX-36] sem a observação do outro na janela, o banco é consultado mesmo assim, uma vez, e o casamento volta gone (A3-1)', async () => {
    const { service, repository, store } = setup();
    await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    const claims = vi.spyOn(store, 'claimTouchPair');
    expect(await service.touches(viewer(A), [b.bleToken])).toEqual(NOTHING);
    expect(repository.findTouchPair).toHaveBeenCalledTimes(1);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(await claims.mock.results[0]?.value).toBe('gone');
  });

  it('[PROX-37] [PROX-49] o cartão leva o token mais recente relatado e alreadyConnected; o cartão devido leva o alreadyConnected do par', async () => {
    const t = setup();
    await t.service.issueToken(viewer(C));
    t.clock.advance(1_000);
    const second = await t.service.issueToken(viewer(C));
    const a = await t.service.issueToken(viewer(A));

    await t.service.touches(viewer(C), [a.bleToken]);
    expect((await t.service.touches(viewer(A), [second.bleToken])).items).toEqual([
      {
        token: second.bleToken,
        handle: 'caio',
        name: 'Caio',
        avatarUrl: null,
        alreadyConnected: true,
        pairExpiresInS: 55,
      },
    ]);
    // A e C são conexões: o cartão de A que C recebe também diz "Conectados" (a linha de A, vista
    // por A, não diria).
    expect((await t.service.touches(viewer(C), [a.bleToken])).items).toEqual([
      {
        token: a.bleToken,
        handle: 'ana',
        name: 'Ana',
        avatarUrl: null,
        alreadyConnected: true,
        pairExpiresInS: 55,
      },
    ]);
  });

  it('[PROX-32] o par vale 60 s depois do último casamento (PROX_TOUCH_PAIR_TTL_S)', async () => {
    const t = setup();
    await touchPair(t, A, B);
    t.clock.advance(59_999);
    expect(await t.service.hasTouchPair(B, A)).toBe(true);
    t.clock.advance(1);
    expect(await t.service.hasTouchPair(A, B)).toBe(false);
  });

  it('[PROX-47] janela e par vêm do env', async () => {
    const { service, clock } = setup({ PROX_TOUCH_WINDOW_S: '2', PROX_TOUCH_PAIR_TTL_S: '5' });
    const a = await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    await service.touches(viewer(A), [b.bleToken]);
    clock.advance(2_000);
    expect((await service.touches(viewer(B), [a.bleToken])).items).toEqual([]);
    clock.advance(1_000);
    expect((await service.touches(viewer(A), [b.bleToken])).items).toHaveLength(1);
    clock.advance(4_999);
    expect(await service.hasTouchPair(A, B)).toBe(true);
    clock.advance(1);
    expect(await service.hasTouchPair(A, B)).toBe(false);
  });

  it('[PROX-04] touches exige a tela aberta de quem chama (409) e não grava nada', async () => {
    const { service, store } = setup();
    const b = await service.issueToken(viewer(B));
    expect(await codeOf(service.touches(viewer(A), [b.bleToken]))).toBe(
      ErrorCode.PROXIMITY_SCREEN_CLOSED,
    );
    expect(keys(store)).not.toContain(proximityKeys.touch(A, B));
  });

  it('[PROX-20] [PROX-34] 60 relatos por minuto (PROXIMITY_TOUCH_LIMIT_PER_MIN); o 61º dá 429 (sem cartão devido, PROX-60). Relato sem par nunca conta como falha', async () => {
    const { service, store, clock } = setup();
    expect(PROXIMITY_LIMITS.touches.limit).toBe(PROXIMITY_TOUCH_LIMIT_PER_MIN);
    await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    const failures = vi.spyOn(service, 'recordFailure');
    // Inexistente, do QR e sem par: 60 relatos passam (com falha, o bloqueio viria no 20º).
    const rotation = [UNKNOWN, b.qrToken, b.bleToken];
    for (let index = 0; index < PROXIMITY_LIMITS.touches.limit; index++) {
      await service.touches(viewer(A), [rotation[index % rotation.length]!]);
    }
    expect(await codeOf(service.touches(viewer(A), [b.bleToken]))).toBe(ErrorCode.RATE_LIMITED);
    expect(failures).not.toHaveBeenCalled();
    expect(await store.lockRemainingMs(A)).toBe(0);
    // O limite é por conta: B continua relatando.
    expect(await codeOf(service.touches(viewer(B), [UNKNOWN]))).toBe('ok');
    // E volta depois da janela de 1 min.
    clock.advance(60_000);
    await service.issueToken(viewer(A));
    expect(await codeOf(service.touches(viewer(A), [b.bleToken]))).toBe('ok');
  });

  it('[PROX-20] com a proximidade bloqueada (20 falhas), touches dá 429', async () => {
    const { service } = setup();
    await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    for (let index = 0; index < PROXIMITY_LIMITS.failures.limit; index++) {
      await service.recordFailure(viewer(A));
    }
    expect(await codeOf(service.touches(viewer(A), [b.bleToken]))).toBe(ErrorCode.RATE_LIMITED);
  });

  it('[PROX-21] Redis fora no meio do relato: 503 PROXIMITY_UNAVAILABLE (fail-closed)', async () => {
    const { service, store } = setup();
    await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    store.failing.add('recordTouch');
    expect(await codeOf(service.touches(viewer(A), [b.bleToken]))).toBe(
      ErrorCode.PROXIMITY_UNAVAILABLE,
    );
  });
});

describe('ProximityService: teto de pessoas novas (ADR 0012, A2-1)', () => {
  /** `caller` casa com `other` (que relatou primeiro); depois, passa o tempo de ocupado. */
  async function marry(t: Setup, caller: string, other: string) {
    const { answer, opening, secondTokens } = await touchPair(t, other, caller);
    // O outro recebe (ou não) o cartão devido no relato seguinte; os dois ficam livres em 10 s.
    const otherNext = await t.service.touches(viewer(other), [secondTokens.bleToken]);
    t.clock.advance(10 * SECOND);
    return { opening, answer, otherNext };
  }

  it('[PROX-45] [PROX-46] acima do teto: [] para os dois lados, sem par, sem cartão devido, sem falha e sem 429; renovar não conta; a hora seguinte libera; o teto do dia continua; o log sai sem ids nem tokens', async () => {
    const t = setup({ PROX_TOUCH_PAIRS_PER_HOUR: '2', PROX_TOUCH_PAIRS_PER_DAY: '3' });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failures = vi.spyOn(t.service, 'recordFailure');

    expect((await marry(t, A, B)).answer.items).toHaveLength(1);
    // Renovar o par A–B (ainda vivo) não conta no teto.
    expect((await marry(t, A, B)).answer.items).toHaveLength(1);
    expect((await marry(t, A, C)).answer.items).toHaveLength(1);

    // O 3º par novo de A na hora: nenhum dos dois lados vê nada, e a resposta é a de não mútuo.
    const capped = await marry(t, A, D);
    const unknown = await t.service.touches(viewer(D), [UNKNOWN]);
    expect(capped.answer).toEqual(unknown);
    expect(capped.otherNext).toEqual(unknown);
    expect(await t.store.hasTouchPair(A, D)).toBe(false);
    expect(keys(t.store)).not.toContain(proximityKeys.owed(A));
    expect(keys(t.store)).not.toContain(proximityKeys.owed(D));
    expect(failures).not.toHaveBeenCalled();

    // O log do teto (uma linha por lado barrado): só o código e o texto fixo, sem ids nem tokens.
    const cappedLines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes(PROXIMITY_TOUCH_CAPPED));
    expect(cappedLines).toEqual([
      `${PROXIMITY_TOUCH_CAPPED}: teto de pessoas novas, encosto não confirmado`,
      `${PROXIMITY_TOUCH_CAPPED}: teto de pessoas novas, encosto não confirmado`,
    ]);
    expect(warn.mock.calls.every((call) => call.length === 1)).toBe(true);

    // D não somou nada na tentativa barrada: casa com E.
    expect((await marry(t, D, E)).answer.items).toHaveLength(1);

    // A hora seguinte libera A (3º par do dia); o 4º do dia continua barrado na hora depois.
    t.clock.advance(HOUR);
    expect((await marry(t, A, D)).answer.items).toHaveLength(1);
    t.clock.advance(HOUR);
    expect((await marry(t, A, E)).answer).toEqual(NOTHING);
    expect(await t.store.hasTouchPair(A, E)).toBe(false);
  });

  it('[PROX-45] o teto vale para os dois: o outro no teto barra quem não está', async () => {
    const t = setup({ PROX_TOUCH_PAIRS_PER_HOUR: '1', PROX_TOUCH_PAIRS_PER_DAY: '1' });
    expect((await marry(t, B, C)).answer.items).toHaveLength(1);
    // A nunca casou; B está no teto. A como quem chama, e B como quem chama: ninguém casa.
    expect((await marry(t, A, B)).answer).toEqual(NOTHING);
    expect((await marry(t, B, A)).answer).toEqual(NOTHING);
    expect(await t.store.hasTouchPair(A, B)).toBe(false);
    // A continua livre para outra pessoa.
    expect((await marry(t, A, D)).answer.items).toHaveLength(1);
  });
});

describe('ProximityService: revelação simétrica garantida (ADR 0012, A2-2)', () => {
  it('[PROX-49] [PROX-67] M casa, recebe o cartão de V e bloqueia V: o relato seguinte de V recebe o cartão de M (do casamento, com o token relatado); os relatos até 10 s depois, o mesmo cartão (A3-2); depois, nada', async () => {
    const t = setup();
    const { secondTokens: m, answer } = await touchPair(t, B, A);
    expect(answer.items).toEqual([expect.objectContaining({ handle: 'bia.alves' })]);
    // M bloqueia V: a política passa a esconder um do outro.
    t.facts.blocks.add(`${A}>${B}`);

    t.clock.advance(SECOND);
    const delivered = await t.service.touches(viewer(B), [m.bleToken]);
    expect(delivered).toEqual({
      items: [
        {
          token: m.bleToken,
          handle: 'ana',
          name: 'Ana',
          avatarUrl: null,
          alreadyConnected: false,
          pairExpiresInS: 55,
        },
      ],
    });
    expect(ProximityTouchResultSchema.parse(delivered)).toEqual(delivered);
    expect(Object.keys(delivered.items[0]!).sort()).toEqual([
      'alreadyConnected',
      'avatarUrl',
      'handle',
      'name',
      'pairExpiresInS',
      'token',
    ]);
    // A3-2: o relato seguinte, em menos de 10 s, recebe o mesmo cartão (a reentrega).
    t.clock.advance(SECOND);
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(delivered);
    // 10 s depois da primeira entrega, nada (e a política agora barra o casamento).
    t.clock.advance(9 * SECOND);
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
  });

  it('[PROX-50] M exclui a conta ou sai (tokens revogados): V relata o token revogado e recebe o cartão de M, sem ler o banco; depois de 60 s sem relato, nada', async () => {
    const t = setup();
    const { secondTokens: m } = await touchPair(t, B, A);
    // Exclusão ou logout de M: tokens revogados e a conta some da política.
    await t.store.revokeUser(A);
    t.facts.deleted.add(A);
    const reads = t.repository.findTouchPair.mock.calls.length;

    await t.service.issueToken(viewer(B));
    const delivered = await t.service.touches(viewer(B), [m.bleToken]);
    expect(delivered.items).toEqual([
      expect.objectContaining({ token: m.bleToken, handle: 'ana', name: 'Ana' }),
    ]);
    expect(t.repository.findTouchPair.mock.calls.length).toBe(reads);

    // Outro par: o cartão devido espera 60 s e some sozinho.
    const late = setup();
    await touchPair(late, C, A);
    late.clock.advance(60 * SECOND);
    await late.service.issueToken(viewer(C));
    expect(await late.service.touches(viewer(C), [UNKNOWN])).toEqual(NOTHING);
  });

  it('[PROX-51] rótulo: o token relatado quando o hash bate ou quando é (válido ou recente) do dono do cartão; de outra pessoa, revogado ou inexistente → um token nunca emitido', async () => {
    const t = setup();
    await touchPair(t, B, A);
    // M rodou o token: V relata o novo (hash diferente do guardado), que é de M.
    t.clock.advance(SECOND);
    const rotated = await t.service.issueToken(viewer(A));
    expect((await t.service.touches(viewer(B), [rotated.bleToken])).items[0]?.token).toBe(
      rotated.bleToken,
    );

    // Token de outra pessoa (P, com quem V também poderia ter par): nunca o rótulo.
    for (const scenario of ['outra pessoa', 'revogado', 'inexistente'] as const) {
      const s = setup();
      const { secondTokens } = await touchPair(s, B, A);
      const other = await s.service.issueToken(viewer(C));
      let reported = other.bleToken;
      if (scenario === 'revogado') {
        const fresh = await s.service.issueToken(viewer(A));
        await s.store.revokeUser(A);
        reported = fresh.bleToken;
      } else if (scenario === 'inexistente') {
        reported = UNKNOWN;
      }
      const [card] = (await s.service.touches(viewer(B), [reported])).items;
      expect(card).toMatchObject({ handle: 'ana', name: 'Ana' });
      expect(card!.token).not.toBe(reported);
      expect(card!.token).not.toBe(secondTokens.bleToken);
      expect(ProximityTokenValueSchema.safeParse(card!.token).success).toBe(true);
      // Nunca emitido nem gravado: o pedido com ele dá o 400 genérico, sem chegar a ninguém.
      expect(await s.service.ownerOfRecentToken(card!.token, 'ble')).toBeNull();
      expect(await s.service.ownerOfRecentToken(card!.token, 'qr')).toBeNull();
    }
  });

  it('[PROX-51] sem o Redis na consulta do rótulo (o cartão já foi retirado): o cartão sai com o token nunca emitido, em vez de se perder num 503', async () => {
    const t = setup();
    await touchPair(t, B, A);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const other = await t.service.issueToken(viewer(C));
    t.store.failing.add('findRecent');
    const [card] = (await t.service.touches(viewer(B), [other.bleToken])).items;
    expect(card).toMatchObject({ handle: 'ana' });
    expect(card!.token).not.toBe(other.bleToken);
  });

  it('[PROX-52] (A) atacante sem janela (A2 rev. 1, R1-1): V relata tM a cada 1 s de 0 a 12 s, com tM2 no meio; M relata tV aos 13, 15 e 21,9 s → nunca casa, sem par e sem cartão devido (com o KEEPTTL antigo, o de 13 s casaria)', async () => {
    const t = setup();
    const start = t.clock.now().getTime();
    const at = (ms: number) => {
      t.clock.set(new Date(start + ms));
    };
    const v = await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    // M religa o transmissor (ou anuncia outro token dele): V vê tM2, outro "encostado".
    const m2 = await t.service.issueToken(viewer(A));
    for (let second = 0; second <= 12; second++) {
      at(second * SECOND);
      const token = second >= 3 && second <= 5 ? m2.bleToken : m.bleToken;
      expect(await t.service.touches(viewer(B), [token])).toEqual(NOTHING);
    }
    // A chave de V sobre M desliza (vence 10 s depois do último relato) e guarda o primeiro, 0 s.
    expect(t.store.entries().find((entry) => entry.key === proximityKeys.touch(B, A))?.value).toBe(
      `${String(start)}:${hashProximityToken(m.bleToken)}`,
    );

    for (const ms of [13_000, 15_000, 21_900]) {
      at(ms);
      expect(await t.service.touches(viewer(A), [v.bleToken])).toEqual(NOTHING);
    }
    expect(await t.store.hasTouchPair(A, B)).toBe(false);
    expect(keys(t.store)).not.toContain(proximityKeys.owed(A));
    expect(keys(t.store)).not.toContain(proximityKeys.owed(B));
    // Aos 22 s (10 s sem relato de V), a chave some: não há observação de V para casar.
    at(22_000);
    expect(keys(t.store)).not.toContain(proximityKeys.touch(B, A));
  });

  it('[PROX-52] [PROX-48] M relata enquanto V ainda relata (9,9 s): quem casa é V, no relato seguinte, e V vê M na hora; M recebe o de V depois (o atraso honesto continua simétrico)', async () => {
    const t = setup();
    const start = t.clock.now().getTime();
    const at = (ms: number) => {
      t.clock.set(new Date(start + ms));
    };
    const v = await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    for (let second = 0; second <= 9; second++) {
      at(second * SECOND);
      expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
    }
    at(9_900);
    expect(await t.service.touches(viewer(A), [v.bleToken])).toEqual(NOTHING);
    at(10_000);
    expect((await t.service.touches(viewer(B), [m.bleToken])).items).toEqual([
      expect.objectContaining({ token: m.bleToken, handle: 'ana' }),
    ]);
    at(11_000);
    expect((await t.service.touches(viewer(A), [v.bleToken])).items).toEqual([
      expect.objectContaining({ token: v.bleToken, handle: 'bia.alves' }),
    ]);
  });

  it('[PROX-52] (B) vários transmissores: V relata tM em 0, tX de 1 a 8 s, tY de 9 a 14 s e tM de novo de 15 s → a chave de V sobre M some aos 10 s e volta aos 15 (janela de 15 a 20); M relata aos 16 s → created, e o relato de V aos 17 s recebe o cartão de M', async () => {
    const t = setup();
    const start = t.clock.now().getTime();
    const at = (ms: number) => {
      t.clock.set(new Date(start + ms));
    };
    const observation = () =>
      t.store.entries().find((entry) => entry.key === proximityKeys.touch(B, A))?.value;
    const v = await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    const x = await t.service.issueToken(viewer(C));
    const y = await t.service.issueToken(viewer(D));
    const claims = vi.spyOn(t.store, 'claimTouchPair');

    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
    for (let second = 1; second <= 14; second++) {
      at(second * SECOND);
      expect(await t.service.touches(viewer(B), [second <= 8 ? x.bleToken : y.bleToken])).toEqual(
        NOTHING,
      );
      expect(observation() === undefined, `${String(second)} s`).toBe(second >= 10);
    }
    at(15 * SECOND);
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
    expect(observation()).toBe(`${String(start + 15 * SECOND)}:${hashProximityToken(m.bleToken)}`);

    at(16 * SECOND);
    expect((await t.service.touches(viewer(A), [v.bleToken])).items).toEqual([
      expect.objectContaining({ token: v.bleToken, handle: 'bia.alves' }),
    ]);
    // A3-1: os 16 relatos de V também rodam o script do casamento (gone: ninguém relatou V); o
    // único que casa é o de M.
    expect(
      await Promise.all(claims.mock.results.map((result) => result.value as Promise<TouchClaim>)),
    ).toEqual([...Array.from({ length: 16 }, () => 'gone'), 'created']);
    at(17 * SECOND);
    expect((await t.service.touches(viewer(B), [m.bleToken])).items).toEqual([
      expect.objectContaining({ token: m.bleToken, handle: 'ana' }),
    ]);
  });

  it('[PROX-52] M casa e passa a anunciar o token de outra conta sua (P): o relato seguinte de V traz o token de P e recebe o cartão de M, com um token que não serve para pedir', async () => {
    const t = setup();
    const { secondTokens: m } = await touchPair(t, B, A);
    const p = await t.service.issueToken(viewer(C));
    const [card] = (await t.service.touches(viewer(B), [p.bleToken])).items;
    expect(card).toMatchObject({ handle: 'ana', name: 'Ana' });
    expect(card!.token).not.toBe(p.bleToken);
    expect(card!.token).not.toBe(m.bleToken);
  });

  it('[PROX-48] atraso honesto, com prazo deslizante: V relata de 0 a 5 s, B só aos 6 s (não casa), V em 7 s casa (V cria o par) e B recebe o cartão de V no relato seguinte', async () => {
    const t = setup();
    const v = await t.service.issueToken(viewer(B));
    const b = await t.service.issueToken(viewer(A));
    for (let second = 0; second <= 5; second++) {
      expect(await t.service.touches(viewer(B), [b.bleToken])).toEqual(NOTHING);
      t.clock.advance(SECOND);
    }
    await t.service.issueToken(viewer(B));
    await t.service.issueToken(viewer(A));
    expect(await t.service.touches(viewer(A), [v.bleToken])).toEqual(NOTHING);
    t.clock.advance(SECOND);
    expect((await t.service.touches(viewer(B), [b.bleToken])).items).toEqual([
      expect.objectContaining({ token: b.bleToken, handle: 'ana' }),
    ]);
    t.clock.advance(SECOND);
    expect((await t.service.touches(viewer(A), [v.bleToken])).items).toEqual([
      expect.objectContaining({ token: v.bleToken, handle: 'bia.alves' }),
    ]);
  });

  it('[PROX-53] uma pessoa por vez: com um cartão a receber, V não casa com X; quem cria o par fica ocupado 10 s; depois, casa', async () => {
    const t = setup();
    const v = await t.service.issueToken(viewer(B));
    const x = await t.service.issueToken(viewer(C));
    const m = await t.service.issueToken(viewer(A));
    // V já tinha relatado X; depois M casa com V (V fica com o cartão de M a receber).
    await t.service.touches(viewer(B), [x.bleToken]);
    t.clock.advance(SECOND);
    await t.service.touches(viewer(B), [m.bleToken]);
    expect((await t.service.touches(viewer(A), [v.bleToken])).items).toHaveLength(1);
    // X relata V com a observação de V ainda na janela: ocupado, a resposta de não mútuo.
    expect(await t.service.touches(viewer(C), [v.bleToken])).toEqual(NOTHING);
    expect(await t.store.hasTouchPair(B, C)).toBe(false);

    // M (que criou o par e recebeu o cartão de V) fica ocupado 10 s: não casa com X.
    await t.service.touches(viewer(C), [m.bleToken]);
    expect(await t.service.touches(viewer(A), [x.bleToken])).toEqual(NOTHING);
    expect(await t.store.hasTouchPair(A, C)).toBe(false);

    // Passados os 10 s: M casa com X.
    t.clock.advance(10 * SECOND);
    const freshX = await t.service.issueToken(viewer(C));
    const freshM = await t.service.issueToken(viewer(A));
    await t.service.touches(viewer(C), [freshM.bleToken]);
    expect((await t.service.touches(viewer(A), [freshX.bleToken])).items).toEqual([
      expect.objectContaining({ handle: 'caio' }),
    ]);
  });

  it('[PROX-54] Redis fora só no casamento ou só na entrega: 503 e nada gravado', async () => {
    const t = setup();
    const a = await t.service.issueToken(viewer(A));
    const b = await t.service.issueToken(viewer(B));
    await t.service.touches(viewer(A), [b.bleToken]);
    t.store.failing.add('claimTouchPair');
    expect(await codeOf(t.service.touches(viewer(B), [a.bleToken]))).toBe(
      ErrorCode.PROXIMITY_UNAVAILABLE,
    );
    expect(await t.store.hasTouchPair(A, B)).toBe(false);
    expect(keys(t.store)).not.toContain(proximityKeys.owed(A));
    t.store.failing.clear();

    const s = setup();
    const sb = await s.service.issueToken(viewer(B));
    await s.service.issueToken(viewer(A));
    s.store.failing.add('takeOwedCard');
    expect(await codeOf(s.service.touches(viewer(A), [sb.bleToken]))).toBe(
      ErrorCode.PROXIMITY_UNAVAILABLE,
    );
    expect(keys(s.store)).not.toContain(proximityKeys.touch(A, B));
  });

  it('[PROX-54] dois relatos simultâneos do mesmo par: um só casamento; o outro lado recebe o cartão devido na chamada seguinte', async () => {
    const t = setup();
    const a = await t.service.issueToken(viewer(A));
    const b = await t.service.issueToken(viewer(B));
    const now = t.clock.now().getTime();
    await t.store.recordTouch(A, B, hashProximityToken(b.bleToken), now, 5_000);
    await t.store.recordTouch(B, A, hashProximityToken(a.bleToken), now, 5_000);
    const claims = vi.spyOn(t.store, 'claimTouchPair');

    const [forA, forB] = await Promise.all([
      t.service.touches(viewer(A), [b.bleToken]),
      t.service.touches(viewer(B), [a.bleToken]),
    ]);
    const outcomes = await Promise.all(
      claims.mock.results.map((result) => result.value as Promise<TouchClaim>),
    );
    expect(outcomes.sort()).toEqual(['busy', 'created']);
    expect(forA.items.length + forB.items.length).toBe(1);

    // Quem ficou sem cartão recebe o devido no relato seguinte; ninguém recebe dois.
    const late = forA.items.length === 0 ? A : B;
    const next = await t.service.touches(viewer(late), [late === A ? b.bleToken : a.bleToken]);
    expect(next.items).toHaveLength(1);
    // A3-2: o cartão entregue fica marcado ("!") para a reentrega, por até 10 s; nenhum outro
    // cartão devido sobra.
    const owed = t.store.entries().filter((entry) => entry.key.startsWith('prox:v:'));
    expect(owed.map((entry) => entry.key)).toEqual([proximityKeys.owed(late)]);
    expect(owed.every((entry) => entry.value.startsWith('!'))).toBe(true);
    t.clock.advance(10 * SECOND);
    expect(keys(t.store).filter((key) => key.startsWith('prox:v:'))).toEqual([]);
  });
});

describe('ProximityService: o cartão devido sai antes de qualquer recusa (ADR 0012, A2 rev. 1, R1-4)', () => {
  /**
   * V (B) relata M (A) e M casa: o cartão de M fica devido a V. `before` roda com as telas já
   * abertas, antes do relato de V (para gastar o limite de V, por exemplo).
   */
  async function owedToV(t: Setup, before: () => Promise<void> = () => Promise.resolve()) {
    const v = await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    await before();
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
    expect((await t.service.touches(viewer(A), [v.bleToken])).items).toHaveLength(1);
    expect(keys(t.store)).toContain(proximityKeys.owed(B));
    return { v, m };
  }

  it('[PROX-60] [PROX-67] o 61º relato no minuto com um cartão devido → 200 com o cartão, sem somar no limite (1ª entrega); a reentrega, logo depois, conta e dá 429', async () => {
    const t = setup();
    const { m } = await owedToV(t, async () => {
      for (let index = 0; index < PROXIMITY_TOUCH_LIMIT_PER_MIN - 1; index++) {
        expect(await t.service.touches(viewer(B), [UNKNOWN])).toEqual(NOTHING);
      }
    });
    const hits = vi.spyOn(t.store, 'hit');
    expect((await t.service.touches(viewer(B), [m.bleToken])).items).toEqual([
      expect.objectContaining({ token: m.bleToken, handle: 'ana' }),
    ]);
    expect(hits).not.toHaveBeenCalled();
    expect(await codeOf(t.service.touches(viewer(B), [m.bleToken]))).toBe(ErrorCode.RATE_LIMITED);
    expect(hits).toHaveBeenCalledTimes(1);
  });

  it('[PROX-60] [PROX-67] com a proximidade de V bloqueada (20 falhas) → 200 com o cartão, e a reentrega também (só passa pelo limite); depois dos 10 s, sem cartão, 429', async () => {
    const t = setup();
    const { m } = await owedToV(t);
    for (let index = 0; index < PROXIMITY_LIMITS.failures.limit; index++) {
      await t.service.recordFailure(viewer(B));
    }
    expect(await t.store.lockRemainingMs(B)).toBeGreaterThan(0);
    const first = await t.service.touches(viewer(B), [m.bleToken]);
    expect(first.items).toEqual([expect.objectContaining({ handle: 'ana' })]);
    t.clock.advance(SECOND);
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(first);
    t.clock.advance(9 * SECOND);
    expect(await codeOf(t.service.touches(viewer(B), [m.bleToken]))).toBe(ErrorCode.RATE_LIMITED);
  });

  it('[PROX-60] [PROX-67] sem prox:u (tela fechada) → 200 com o cartão, e a reentrega também; depois dos 10 s, sem cartão, 409', async () => {
    const t = setup();
    const { m } = await owedToV(t);
    // A tela de V fechou (prox:u vence em 30 s); o cartão devido espera 60 s.
    t.clock.advance(30 * SECOND);
    expect(await t.store.isScreenOpen(B)).toBe(false);
    const first = await t.service.touches(viewer(B), [m.bleToken]);
    expect(first.items).toEqual([expect.objectContaining({ token: m.bleToken, handle: 'ana' })]);
    t.clock.advance(SECOND);
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(first);
    t.clock.advance(9 * SECOND);
    expect(await codeOf(t.service.touches(viewer(B), [m.bleToken]))).toBe(
      ErrorCode.PROXIMITY_SCREEN_CLOSED,
    );
  });

  it('[PROX-60] Valkey fora no takeOwedCard → 503 antes de qualquer outra coisa, e o cartão continua guardado', async () => {
    const t = setup();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await owedToV(t);
    const steps = ['lockRemainingMs', 'hit', 'isScreenOpen'] as const;
    const spies = steps.map((step) => vi.spyOn(t.store, step));
    t.store.failing.add('takeOwedCard');
    expect(await codeOf(t.service.touches(viewer(B), [UNKNOWN]))).toBe(
      ErrorCode.PROXIMITY_UNAVAILABLE,
    );
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(keys(t.store)).toContain(proximityKeys.owed(B));
    t.store.failing.clear();
    expect((await t.service.touches(viewer(B), [UNKNOWN])).items).toEqual([
      expect.objectContaining({ handle: 'ana' }),
    ]);
  });
});

describe('ProximityService: o mesmo caminho para todo token válido (ADR 0012, A3-1, R22)', () => {
  interface Tokens {
    v: { bleToken: string };
    m: { bleToken: string };
  }

  /**
   * V (B) e M (A) abrem a tela; `arrange` prepara o caminho; V relata o `bleToken` de M. Devolve as
   * idas desse relato (store e repositório, na ordem), o resultado do script, o `callerCard` que
   * chegou a ele e a resposta.
   */
  async function measure(t: Setup, arrange: (tokens: Tokens) => Promise<void>) {
    const v = await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    await arrange({ v, m });
    const claims = vi.spyOn(t.store, 'claimTouchPair');
    t.store.calls.length = 0;
    const answer = await t.service.touches(viewer(B), [m.bleToken]);
    return {
      calls: [...t.store.calls],
      outcomes: await Promise.all(
        claims.mock.results.map((result) => result.value as Promise<TouchClaim>),
      ),
      cards: claims.mock.calls.map(([input]) => input.callerCard),
      answer,
    };
  }

  /** M relata V primeiro: a observação de M sobre V fica na janela. */
  const mReportsV = (t: Setup) => async (tokens: Tokens) => {
    expect(await t.service.touches(viewer(A), [tokens.v.bleToken])).toEqual(NOTHING);
  };

  it('[PROX-66] [PROX-46] não mútuo, recusa pela política (bloqueio em cada sentido, conta excluída, criador e conta sem linha, de cada lado), capped, busy e casamento: as mesmas idas, na mesma ordem, com o findTouchPair e o claimTouchPair uma vez cada; B, C e D com o mesmo corpo', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const scenarios: {
      name: string;
      overrides?: Record<string, string>;
      arrange: (t: Setup) => (tokens: Tokens) => Promise<void>;
      outcome: TouchClaim;
    }[] = [
      { name: 'B. não mútuo', arrange: () => () => Promise.resolve(), outcome: 'gone' },
      // V (B) relata M (A), com a observação de M sobre V na janela: cada recusa, dos dois lados.
      ...refusals(B, A).map(({ name, refuse }) => ({
        name: `C. ${name}`,
        arrange: (t: Setup) => async (tokens: Tokens) => {
          await mReportsV(t)(tokens);
          refuse(t.facts);
        },
        outcome: 'refused' as const,
      })),
      {
        // A exclusão revoga os tokens em silêncio (`revokeQuietly`); com o Valkey fora nessa hora,
        // o token de M ainda vale, e quem recusa é a política (a linha de M volta com `active`
        // falso).
        name: 'C. M excluiu a conta depois do relato dele',
        arrange: (t) => async (tokens) => {
          await mReportsV(t)(tokens);
          t.store.failing.add('revokeUser');
          await t.service.revokeQuietly(A);
          t.store.failing.delete('revokeUser');
          t.facts.deleted.add(A);
        },
        outcome: 'refused',
      },
      {
        // M já casou com C nesta hora (teto de 1); passado o ocupado, M relata V.
        name: 'D. capped',
        overrides: { PROX_TOUCH_PAIRS_PER_HOUR: '1', PROX_TOUCH_PAIRS_PER_DAY: '1' },
        arrange: (t) => async (tokens) => {
          const c = await t.service.issueToken(viewer(C));
          await t.service.touches(viewer(C), [tokens.m.bleToken]);
          expect((await t.service.touches(viewer(A), [c.bleToken])).items).toHaveLength(1);
          t.clock.advance(10 * SECOND);
          await mReportsV(t)(tokens);
        },
        outcome: 'capped',
      },
      {
        // M acabou de casar com C (ocupado por 10 s) e relata V.
        name: 'D. busy',
        arrange: (t) => async (tokens) => {
          const c = await t.service.issueToken(viewer(C));
          await t.service.touches(viewer(C), [tokens.m.bleToken]);
          expect((await t.service.touches(viewer(A), [c.bleToken])).items).toHaveLength(1);
          await mReportsV(t)(tokens);
        },
        outcome: 'busy',
      },
      { name: 'E. casamento', arrange: mReportsV, outcome: 'created' },
    ];

    const bodies: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      const t = setup(scenario.overrides);
      const result = await measure(t, scenario.arrange(t));
      expect(result.calls, scenario.name).toEqual(TOUCH_PATH);
      expect(result.outcomes, scenario.name).toEqual([scenario.outcome]);
      expect(result.cards[0] === null, scenario.name).toBe(scenario.outcome === 'refused');
      bodies[scenario.name] = result.answer;
    }
    // Os recusados, o teto e o ocupado dão o mesmo corpo do não mútuo (PROX-46); só o casamento
    // traz o cartão (e assina a foto depois das mesmas idas).
    const { 'E. casamento': married, ...refused } = bodies;
    for (const [name, body] of Object.entries(refused)) {
      expect(body, name).toEqual(NOTHING);
    }
    expect(married).toEqual({ items: [expect.objectContaining({ handle: 'ana' })] });
  });

  it('[PROX-66] [PROX-32] token inexistente, do QR, próprio ou vencido para no findValid: sem observação, política nem casamento (depende só do token)', async () => {
    const t = setup();
    const old = await t.service.issueToken(viewer(C));
    t.clock.advance(30 * SECOND);
    const own = await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    for (const token of [UNKNOWN, m.qrToken, own.bleToken, old.bleToken]) {
      t.store.calls.length = 0;
      expect(await t.service.touches(viewer(B), [token])).toEqual(NOTHING);
      expect(t.store.calls, token).toEqual(TOUCH_PATH.slice(0, 5));
    }
    expect(t.repository.findTouchPair).not.toHaveBeenCalled();
    expect(t.repository.findNearby).not.toHaveBeenCalled();
  });

  it('[PROX-66] [PROX-35] com o claimTouchPair fora, também o relato não mútuo dá 503 (fail-closed em todo caminho)', async () => {
    const t = setup();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    t.store.failing.add('claimTouchPair');
    expect(await codeOf(t.service.touches(viewer(B), [m.bleToken]))).toBe(
      ErrorCode.PROXIMITY_UNAVAILABLE,
    );
    expect(await t.store.hasTouchPair(A, B)).toBe(false);
  });

  it('[PROX-66] [PROX-36] as linhas recusadas trazem o @, o nome e a foto, que não saem para a resposta, o log, o erro (503), o script nem o Valkey; com a política aceitando, saem (controle)', async () => {
    const levels = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
    const logs = levels.map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const secretsOf = (id: string) => [
      PEOPLE[id]!.handle,
      PEOPLE[id]!.name,
      PEOPLE[id]!.avatarKey!,
    ];
    const secrets = [...secretsOf(F), ...secretsOf(G)];
    const leaks = (value: unknown, alsoIds = false) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return [...secrets, ...(alsoIds ? [F, G] : [])].filter((secret) => text.includes(secret));
    };

    /** V (G) e M (F) relatam um ao outro; com `claimDown`, o script do casamento cai (503). */
    async function exchange(refuse: (facts: Setup['facts']) => void, claimDown: boolean) {
      const t = setup();
      const claims = vi.spyOn(t.store, 'claimTouchPair');
      const v = await t.service.issueToken(viewer(G));
      const m = await t.service.issueToken(viewer(F));
      refuse(t.facts);
      if (claimDown) {
        t.store.failing.add('claimTouchPair');
      }
      const outputs: unknown[] = [];
      for (const [caller, token] of [
        [F, v.bleToken],
        [G, m.bleToken],
      ] as const) {
        try {
          outputs.push(await t.service.touches(viewer(caller), [token]));
        } catch (error) {
          const failure = error as DomainError;
          outputs.push({
            code: failure.code,
            message: failure.message,
            details: failure.details,
            text: String(failure),
          });
        }
      }
      return { t, claims, outputs };
    }

    for (const { name, refuse } of refusals(G, F)) {
      for (const claimDown of [false, true]) {
        const label = `${name}${claimDown ? ' (script fora)' : ''}`;
        const { t, claims, outputs } = await exchange(refuse, claimDown);
        expect(t.repository.findTouchPair, label).toHaveBeenCalledTimes(2);
        const unavailable: unknown = expect.objectContaining({
          code: ErrorCode.PROXIMITY_UNAVAILABLE,
        });
        expect(outputs, label).toEqual(claimDown ? [unavailable, unavailable] : [NOTHING, NOTHING]);
        expect(leaks(outputs), label).toEqual([]);
        expect(
          claims.mock.calls.map(([input]) => input.callerCard),
          label,
        ).toEqual([null, null]);
        expect(leaks(claims.mock.calls), label).toEqual([]);
        expect(leaks(t.store.entries()), label).toEqual([]);
        expect(t.media.signUrl, label).not.toHaveBeenCalled();
      }
    }
    // Nenhuma linha de log, em nenhum nível, com o @, o nome, a foto ou o id (o 503 deixa um warn).
    const lines = logs.flatMap((spy) => spy.mock.calls);
    expect(lines.length).toBeGreaterThan(0);
    expect(leaks(lines, true)).toEqual([]);

    // Controle: com a política aceitando, as mesmas idas levam o cartão de cada um ao script e o de
    // F (com a foto assinada) à resposta de G: o teste enxergaria o vazamento.
    const { claims, outputs } = await exchange(() => undefined, false);
    expect(leaks(claims.mock.calls)).toEqual(secrets);
    expect(leaks(outputs)).toEqual(secretsOf(F));
  });
});

describe('ProximityService: reentrega do cartão devido (ADR 0012, A3-2, R23)', () => {
  /** V (B) relata M (A) e M casa: o cartão de M fica devido a V. Devolve os tokens e o horário. */
  async function owedToV(t: Setup) {
    const v = await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
    t.clock.advance(800);
    expect((await t.service.touches(viewer(A), [v.bleToken])).items).toHaveLength(1);
    return { v, m, marriedAt: t.clock.now().getTime() };
  }

  it('[PROX-67] a 1ª entrega fora do limite; em menos de 10 s, a reentrega: o mesmo cartão, contando no limite, sem regravar o prazo nem o ocupado e sem passar pela política; aos 10 s, o relato segue o caminho normal', async () => {
    const t = setup();
    const { m, marriedAt } = await owedToV(t);
    const hits = vi.spyOn(t.store, 'hit');
    const reads = t.repository.findTouchPair.mock.calls.length;

    t.clock.advance(SECOND);
    const first = await t.service.touches(viewer(B), [m.bleToken]);
    expect(first.items).toEqual([
      {
        token: m.bleToken,
        handle: 'ana',
        name: 'Ana',
        avatarUrl: null,
        alreadyConnected: false,
        pairExpiresInS: 55,
      },
    ]);
    expect(hits).not.toHaveBeenCalled();
    const owed = rawEntry(t.store, proximityKeys.owed(B));
    const busy = rawEntry(t.store, proximityKeys.busy(B));
    expect(owed?.value.startsWith('!')).toBe(true);
    expect(owed?.expiresAt).toBe(marriedAt + SECOND + 10 * SECOND);
    expect(busy?.expiresAt).toBe(marriedAt + SECOND + 10 * SECOND);

    t.clock.advance(5 * SECOND);
    t.store.calls.length = 0;
    const again = await t.service.touches(viewer(B), [m.bleToken]);
    expect(again).toEqual({ items: [{ ...first.items[0]!, pairExpiresInS: 50 }] });
    // Só a retirada e o limite: nem bloqueio, nem tela, nem política (o rótulo bate com o hash).
    expect(t.store.calls).toEqual(['takeOwedCard', 'hit']);
    expect(hits).toHaveBeenLastCalledWith(
      `rl:${PROXIMITY_LIMITS.touches.name}:${B}`,
      PROXIMITY_LIMITS.touches.windowMs,
    );
    expect(rawEntry(t.store, proximityKeys.owed(B))).toEqual(owed);
    expect(rawEntry(t.store, proximityKeys.busy(B))).toEqual(busy);
    expect(t.repository.findTouchPair.mock.calls.length).toBe(reads);

    // 9,999 s depois da 1ª entrega (10,999 s depois do casamento): ainda a reentrega.
    t.clock.advance(5 * SECOND - 1);
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual({
      items: [{ ...first.items[0]!, pairExpiresInS: 45 }],
    });

    t.clock.advance(1);
    t.store.calls.length = 0;
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
    expect(t.store.calls).toEqual(TOUCH_PATH);
    expect(keys(t.store)).not.toContain(proximityKeys.owed(B));
  });

  it('[PROX-67] [PROX-51] o rótulo é recalculado em cada entrega: a reentrega com o token de outra pessoa sai com um token nunca emitido; com o de M, de novo o token relatado', async () => {
    const t = setup();
    const { m } = await owedToV(t);
    const p = await t.service.issueToken(viewer(C));
    expect((await t.service.touches(viewer(B), [m.bleToken])).items[0]?.token).toBe(m.bleToken);

    const [card] = (await t.service.touches(viewer(B), [p.bleToken])).items;
    expect(card).toMatchObject({ handle: 'ana', name: 'Ana' });
    expect(card!.token).not.toBe(p.bleToken);
    expect(card!.token).not.toBe(m.bleToken);
    expect(ProximityTokenValueSchema.safeParse(card!.token).success).toBe(true);
    expect(await t.service.ownerOfRecentToken(card!.token, 'ble')).toBeNull();

    expect((await t.service.touches(viewer(B), [m.bleToken])).items[0]?.token).toBe(m.bleToken);
  });

  it('[PROX-67] [PROX-51] na reentrega, o rótulo só confere o hash do casamento: com outro token (o girado do dono, um recente dele, o QR dele, o de outra pessoa ou inexistente), um token nunca emitido, sem o findRecent; com o do casamento, ele', async () => {
    const t = setup();
    // Um token de M de 35 s antes do casamento: vencido, mas ainda recente (até 120 s).
    const old = await t.service.issueToken(viewer(A));
    t.clock.advance(35 * SECOND);
    const { m } = await owedToV(t);
    const p = await t.service.issueToken(viewer(C));
    // 1ª entrega, com o token do casamento; a resposta se perde, e M gira o token.
    expect((await t.service.touches(viewer(B), [m.bleToken])).items[0]?.token).toBe(m.bleToken);
    const rotated = await t.service.issueToken(viewer(A));
    // Controle: o recente e o girado são de M (a 1ª entrega os aceitaria pelo findRecent).
    expect(await t.service.ownerOfRecentToken(old.bleToken, 'ble')).toBe(A);
    expect(await t.service.ownerOfRecentToken(rotated.bleToken, 'ble')).toBe(A);

    const reported = [rotated.bleToken, old.bleToken, rotated.qrToken, p.bleToken, UNKNOWN];
    for (const token of reported) {
      t.store.calls.length = 0;
      const [card] = (await t.service.touches(viewer(B), [token])).items;
      expect(card, token).toMatchObject({ handle: 'ana', name: 'Ana', alreadyConnected: false });
      expect([...reported, m.bleToken], token).not.toContain(card!.token);
      expect(ProximityTokenValueSchema.safeParse(card!.token).success, token).toBe(true);
      // Só a retirada e o limite, sem o findRecent: como a reentrega com o token do casamento.
      expect(t.store.calls, token).toEqual(['takeOwedCard', 'hit']);
      // Nunca emitido nem gravado: o pedido com ele dá o 400 genérico.
      expect(await t.service.ownerOfRecentToken(card!.token, 'ble'), token).toBeNull();
    }

    t.store.calls.length = 0;
    expect((await t.service.touches(viewer(B), [m.bleToken])).items[0]?.token).toBe(m.bleToken);
    expect(t.store.calls).toEqual(['takeOwedCard', 'hit']);
  });

  it('[PROX-67] [PROX-51] a 1ª entrega mantém a regra: o token girado ou recente do dono é o rótulo (pelo findRecent); a reentrega com o mesmo token já não é (o custo documentado: o estado 22, sem Conectar)', async () => {
    for (const which of ['girado', 'recente'] as const) {
      const t = setup();
      const old = await t.service.issueToken(viewer(A));
      t.clock.advance(35 * SECOND);
      await owedToV(t);
      const rotated = await t.service.issueToken(viewer(A));
      const token = which === 'girado' ? rotated.bleToken : old.bleToken;

      t.store.calls.length = 0;
      expect((await t.service.touches(viewer(B), [token])).items[0]?.token, which).toBe(token);
      expect(t.store.calls, which).toEqual(['takeOwedCard', 'findRecent']);

      t.store.calls.length = 0;
      const [again] = (await t.service.touches(viewer(B), [token])).items;
      expect(again, which).toMatchObject({ handle: 'ana' });
      expect(again!.token, which).not.toBe(token);
      expect(t.store.calls, which).toEqual(['takeOwedCard', 'hit']);
    }
  });

  it('[PROX-67] [PROX-60] a reentrega acima do limite → 429, sem mexer no cartão nem no ocupado; com o limite renovado, ainda nos 10 s, o mesmo cartão sai; depois, nada', async () => {
    const t = setup();
    const start = t.clock.now().getTime();
    const at = (ms: number) => {
      t.clock.set(new Date(start + ms));
    };
    await t.service.issueToken(viewer(B));
    // 59 relatos de V abrem a janela do limite em 0 s (vai até 60 s).
    for (let index = 0; index < PROXIMITY_TOUCH_LIMIT_PER_MIN - 1; index++) {
      expect(await t.service.touches(viewer(B), [UNKNOWN])).toEqual(NOTHING);
    }
    at(52 * SECOND);
    const v = await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
    expect((await t.service.touches(viewer(A), [v.bleToken])).items).toHaveLength(1);

    at(53 * SECOND);
    const first = await t.service.touches(viewer(B), [m.bleToken]);
    expect(first.items).toEqual([expect.objectContaining({ handle: 'ana', pairExpiresInS: 55 })]);
    const owed = rawEntry(t.store, proximityKeys.owed(B));
    const busy = rawEntry(t.store, proximityKeys.busy(B));

    at(54 * SECOND);
    expect(await codeOf(t.service.touches(viewer(B), [m.bleToken]))).toBe(ErrorCode.RATE_LIMITED);
    expect(rawEntry(t.store, proximityKeys.owed(B))).toEqual(owed);
    expect(rawEntry(t.store, proximityKeys.busy(B))).toEqual(busy);

    at(60 * SECOND);
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual({
      items: [{ ...first.items[0]!, pairExpiresInS: 50 }],
    });
    at(63 * SECOND);
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
  });
});

describe('ProximityService: quanto falta para o par vencer, no cartão (ADR 0012, A2 rev. 1)', () => {
  /** V (B) relata M (A); 800 ms depois, M casa. Devolve o cartão de V que M recebe. */
  async function marryAt(t: Setup) {
    const v = await t.service.issueToken(viewer(B));
    const m = await t.service.issueToken(viewer(A));
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
    t.clock.advance(800);
    const [card] = (await t.service.touches(viewer(A), [v.bleToken])).items;
    return { m, card: card! };
  }

  it('[PROX-64] a mesma conta nos dois caminhos, do horário do casamento, em múltiplos de 5 s para baixo: casamento na hora → 55; cartão devido 16,5 s depois → 40', async () => {
    const t = setup();
    const { m, card } = await marryAt(t);
    expect(card.pairExpiresInS).toBe(55);
    t.clock.advance(16_500);
    const [owed] = (await t.service.touches(viewer(B), [m.bleToken])).items;
    expect(owed).toMatchObject({ handle: 'ana', pairExpiresInS: 40 });
    expect(ProximityTouchResultSchema.parse({ items: [owed] })).toEqual({ items: [owed] });
  });

  it('[PROX-37] [PROX-64] o prazo não revela quem casou primeiro: o casamento na hora e o cartão devido entregue 1 s (ou até 4,999 s) depois dão o mesmo valor', async () => {
    for (const delay of [1_000, 4_999]) {
      const t = setup();
      const { m, card } = await marryAt(t);
      t.clock.advance(delay);
      const [owed] = (await t.service.touches(viewer(B), [m.bleToken])).items;
      expect(owed?.pairExpiresInS, `${String(delay)} ms`).toBe(card.pairExpiresInS);
    }
  });

  it('[PROX-64] cartão devido que chega tarde (a pessoa voltou à tela aos 50 s) → 5; aos 55 s ou mais → 0, nunca negativo; relógio atrás do casamento (outra instância) → no máximo 55, nunca 60 (A3-5)', async () => {
    for (const [elapsed, expected] of [
      [5_000, 50],
      [50_000, 5],
      [54_999, 5],
      [55_000, 0],
      [59_999, 0],
      [-1, 55],
      [-5_000, 55],
      [-60_000, 55],
    ] as const) {
      const t = setup();
      const { m } = await marryAt(t);
      t.clock.advance(elapsed);
      const [owed] = (await t.service.touches(viewer(B), [m.bleToken])).items;
      expect(owed?.pairExpiresInS, `${String(elapsed)} ms`).toBe(expected);
    }
  });

  it('[PROX-64] a validade vem do env (PROX_TOUCH_PAIR_TTL_S); o teto é a validade − 5 (A3-5)', async () => {
    const t = setup({ PROX_TOUCH_PAIR_TTL_S: '20' });
    const { m, card } = await marryAt(t);
    expect(card.pairExpiresInS).toBe(15);
    t.clock.advance(3_200);
    expect((await t.service.touches(viewer(B), [m.bleToken])).items[0]?.pairExpiresInS).toBe(15);

    const skewed = setup({ PROX_TOUCH_PAIR_TTL_S: '20' });
    const late = await marryAt(skewed);
    skewed.clock.advance(-10_000);
    expect(
      (await skewed.service.touches(viewer(B), [late.m.bleToken])).items[0]?.pairExpiresInS,
    ).toBe(15);
  });

  it('[PROX-64] [PROX-67] a reentrega recalcula o pairExpiresInS pela mesma fórmula, do horário do casamento, e nunca passa de 55', async () => {
    const t = setup();
    const { m, card } = await marryAt(t);
    expect(card.pairExpiresInS).toBe(55);
    const values: number[] = [];
    // A 1ª entrega 1 s depois e as reentregas a cada 1 s, até os 10 s (cada uma conta no limite).
    for (let second = 1; second <= 10; second++) {
      t.clock.advance(SECOND);
      values.push((await t.service.touches(viewer(B), [m.bleToken])).items[0]!.pairExpiresInS);
    }
    expect(values).toEqual([55, 55, 55, 55, 50, 50, 50, 50, 50, 45]);
    expect(Math.max(...values)).toBeLessThanOrEqual(55);
  });
});

describe('ProximityService: par vivo para bloquear e denunciar pelo cartão (ADR 0012, A2 rev. 1, R1-5)', () => {
  it('[PROX-61] [PROX-62] hasLiveTouchPair: verdadeiro até 59,999 s depois do casamento, falso aos 60 s; só lê o par (não consome)', async () => {
    const t = setup();
    await touchPair(t, B, A);
    expect(await t.service.hasLiveTouchPair(B, A)).toBe(true);
    expect(await t.service.hasLiveTouchPair(A, B)).toBe(true);
    expect(await t.service.hasLiveTouchPair(B, A)).toBe(true);
    expect(await t.service.hasLiveTouchPair(B, C)).toBe(false);
    t.clock.advance(60 * SECOND - 1);
    expect(await t.service.hasLiveTouchPair(B, A)).toBe(true);
    t.clock.advance(1);
    expect(await t.service.hasLiveTouchPair(B, A)).toBe(false);
  });

  it('[PROX-61] [PROX-62] sem conta: consulta a chave do próprio id nos dois lados, que nunca existe (o mesmo acesso ao Valkey de um @ que existe)', async () => {
    const t = setup();
    await touchPair(t, B, A);
    const reads = vi.spyOn(t.store, 'hasTouchPair');
    expect(await t.service.hasLiveTouchPair(B, undefined)).toBe(false);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenLastCalledWith(B, B);
  });

  it('[PROX-61] [PROX-62] fail-closed: Valkey fora ou lento (> 500 ms) → 503 PROXIMITY_UNAVAILABLE, com conta ou sem', async () => {
    const t = setup();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    t.store.failing.add('hasTouchPair');
    expect(await codeOf(t.service.hasLiveTouchPair(B, A))).toBe(ErrorCode.PROXIMITY_UNAVAILABLE);
    expect(await codeOf(t.service.hasLiveTouchPair(B, undefined))).toBe(
      ErrorCode.PROXIMITY_UNAVAILABLE,
    );
    t.store.failing.clear();

    vi.useFakeTimers();
    vi.spyOn(t.store, 'hasTouchPair').mockImplementationOnce(
      () => new Promise<boolean>(() => undefined),
    );
    const pending = codeOf(t.service.hasLiveTouchPair(B, A));
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe(ErrorCode.PROXIMITY_UNAVAILABLE);
  });
});

describe('ProximityService: sinal de bloqueio depois do encosto (ADR 0012, A2-3)', () => {
  it('[PROX-55] com o par vivo, soma para quem bloqueou e para quem foi bloqueado; no 3º em 7 dias, devolve o papel (só uma vez na janela)', async () => {
    const t = setup();
    // M (A) encosta em B, C e D; cada um bloqueia M logo depois.
    const flags = [];
    for (const victim of [B, C, D]) {
      await touchPair(t, victim, A);
      flags.push(await t.service.noteBlockAfterTouch(victim, A));
      t.clock.advance(10 * SECOND);
    }
    expect(flags).toEqual([[], [], [{ userId: A, role: 'blocked' }]]);
    // O 4º não repete o sinal.
    await touchPair(t, E, A);
    expect(await t.service.noteBlockAfterTouch(E, A)).toEqual([]);

    // Quem bloqueia 3 pessoas logo depois de encostar também.
    const s = setup();
    const results = [];
    for (const other of [B, C, D]) {
      await touchPair(s, other, A);
      results.push(await s.service.noteBlockAfterTouch(A, other));
      s.clock.advance(10 * SECOND);
    }
    expect(results[2]).toEqual([{ userId: A, role: 'blocker' }]);

    // A janela é de 7 dias: depois, o contador recomeça.
    t.clock.advance(7 * 24 * HOUR);
    for (const victim of [B, C]) {
      await touchPair(t, victim, A);
      expect(await t.service.noteBlockAfterTouch(victim, A)).toEqual([]);
      t.clock.advance(10 * SECOND);
    }
    await touchPair(t, D, A);
    expect(await t.service.noteBlockAfterTouch(D, A)).toEqual([{ userId: A, role: 'blocked' }]);
  });

  it('[PROX-55] sem par (ou depois dos 60 s) não soma; um script só (countBlockSignal) com a janela de 7 dias; os contadores guardam só números', async () => {
    const t = setup();
    const signals = vi.spyOn(t.store, 'countBlockSignal');
    const hits = vi.spyOn(t.store, 'hit');
    expect(await t.service.noteBlockAfterTouch(A, B)).toEqual([]);
    await touchPair(t, B, A);
    t.clock.advance(60 * SECOND);
    expect(await t.service.noteBlockAfterTouch(B, A)).toEqual([]);
    expect(
      await Promise.all(
        signals.mock.results.map((result) => result.value as Promise<BlockSignalCounts | null>),
      ),
    ).toEqual([null, null]);

    await touchPair(t, C, A);
    await t.service.noteBlockAfterTouch(C, A);
    expect(signals).toHaveBeenLastCalledWith(C, A, PROXIMITY_LIMITS.blockAfterTouch.windowMs);
    expect(await signals.mock.results.at(-1)?.value).toEqual({ blocker: 1, blocked: 1 });
    // O sinal não passa mais pelo `hit` (um script só, R1-6).
    expect(hits.mock.calls.filter(([key]) => key.includes('block-after-touch'))).toEqual([]);
    const counters = (t.store as unknown as { counters: Map<string, { count: number }> }).counters;
    expect(
      [...counters]
        .filter(([key]) => key.includes('block-after-touch'))
        .map(([key, value]) => [key, value.count]),
    ).toEqual([
      [`rl:prox-block-after-touch:blocker:${C}`, 1],
      [`rl:prox-block-after-touch:blocked:${A}`, 1],
    ]);
  });

  it('[PROX-55] falha aberta: Redis fora → [] sem lançar; lento (> 500 ms) → [] no prazo, e a resposta atrasada não vira sinal', async () => {
    const t = setup();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await touchPair(t, B, A);
    t.store.failing.add('countBlockSignal');
    expect(await t.service.noteBlockAfterTouch(B, A)).toEqual([]);
    t.store.failing.clear();
    // O log não leva ids.
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).not.toMatch(
      new RegExp(`${A}|${B}`),
    );

    vi.useFakeTimers();
    let answer: (value: BlockSignalCounts) => void = () => undefined;
    vi.spyOn(t.store, 'countBlockSignal').mockImplementationOnce(
      () =>
        new Promise<BlockSignalCounts | null>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = t.service.noteBlockAfterTouch(B, A);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual([]);
    answer({ blocker: 3, blocked: 3 });
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('ProximityService: o sinal conta uma vez por casamento e por sentido (ADR 0012, A2 rev. 1, R1-6)', () => {
  const blocked = (t: Setup, userId: string) =>
    (t.store as unknown as { counters: Map<string, { count: number }> }).counters.get(
      `rl:prox-block-after-touch:blocked:${userId}`,
    )?.count ?? 0;
  const blocker = (t: Setup, userId: string) =>
    (t.store as unknown as { counters: Map<string, { count: number }> }).counters.get(
      `rl:prox-block-after-touch:blocker:${userId}`,
    )?.count ?? 0;

  it('[PROX-63] 5 bloqueios simultâneos de V para M → +1 em blocker:V e em blocked:M; bloquear de novo não soma; M bloqueando V conta uma vez no sentido dele', async () => {
    const t = setup();
    await touchPair(t, B, A);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => t.service.noteBlockAfterTouch(B, A)),
    );
    expect(results).toEqual([[], [], [], [], []]);
    expect([blocker(t, B), blocked(t, A)]).toEqual([1, 1]);
    // Bloquear, desbloquear e bloquear de novo (pelo @ ou pelo commentId): nada a mais.
    await t.service.noteBlockAfterTouch(B, A);
    expect([blocker(t, B), blocked(t, A)]).toEqual([1, 1]);
    // M também bloqueia V.
    await t.service.noteBlockAfterTouch(A, B);
    await t.service.noteBlockAfterTouch(A, B);
    expect([blocker(t, A), blocked(t, B)]).toEqual([1, 1]);
    // O par continua vivo (não é consumido): o pedido, o bloqueio e a denúncia ainda valem.
    expect(await t.service.hasLiveTouchPair(B, A)).toBe(true);
  });

  it('[PROX-63] uma conta sozinha não leva M a 3 sem 3 casamentos; um casamento novo (renovação) pode contar de novo; no 3º, o sinal', async () => {
    const t = setup();
    for (let round = 1; round <= 3; round++) {
      await touchPair(t, B, A);
      for (let attempt = 0; attempt < 4; attempt++) {
        const flags = await t.service.noteBlockAfterTouch(B, A);
        expect(flags, `rodada ${String(round)}`).toEqual(
          round === 3 && attempt === 0
            ? [
                { userId: B, role: 'blocker' },
                { userId: A, role: 'blocked' },
              ]
            : [],
        );
      }
      expect(blocked(t, A)).toBe(round);
      // O cartão de A, devido a B, sai; os dois ficam livres depois do ocupado.
      await t.service.touches(viewer(B), [UNKNOWN]);
      t.clock.advance(10 * SECOND);
    }
  });
});

describe('ProximityService: simulação em desenvolvimento (ADR 0012 §7, A2-2 §7)', () => {
  it('[PROX-42] a persona relata o encosto; o relato da conta com o bleToken dela fecha o casamento', async () => {
    const { service, store } = setup();
    await service.issueToken(viewer(A));
    const persona = await service.issueForSimulation(B);
    await service.simulateTouchFrom(B, A);
    expect((await service.touches(viewer(A), [persona.bleToken])).items).toEqual([
      expect.objectContaining({ token: persona.bleToken, handle: 'bia.alves' }),
    ]);
    expect(await store.hasTouchPair(A, B)).toBe(true);
  });

  it('[PROX-42] a simulação apaga o cartão devido e a marca de ocupado da persona: dá para simular de novo depois do ocupado da conta', async () => {
    const { service, store, clock } = setup();
    await service.issueToken(viewer(A));
    const first = await service.issueForSimulation(B);
    await service.simulateTouchFrom(B, A);
    await service.touches(viewer(A), [first.bleToken]);
    // A persona nunca relata: o cartão de A ficou devido a ela.
    expect(keys(store)).toContain(proximityKeys.owed(B));

    clock.advance(10 * SECOND);
    await service.issueToken(viewer(A));
    const second = await service.issueForSimulation(B);
    await service.simulateTouchFrom(B, A);
    expect(keys(store)).not.toContain(proximityKeys.owed(B));
    expect((await service.touches(viewer(A), [second.bleToken])).items).toHaveLength(1);
  });

  it('[PROX-42] simulateTouchPair grava o par da persona com a conta', async () => {
    const { service } = setup();
    await service.simulateTouchPair(B, A);
    expect(await service.hasTouchPair(A, B)).toBe(true);
  });
});
