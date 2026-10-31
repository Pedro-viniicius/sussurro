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
import type { NearbyRow, ProximityRepository } from './proximity.repository.js';
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
import type { AccessPolicyService } from '../policies/access-policy.service.js';

const A = '01a189e0-af57-7000-85fe-2054e618fe0a';
const B = '01a189e0-af57-7000-85fe-2054e618fe0b';
const C = '01a189e0-af57-7000-85fe-2054e618fe0c';
const D = '01a189e0-af57-7000-85fe-2054e618fe0d';
const E = '01a189e0-af57-7000-85fe-2054e618fe0e';
const UNKNOWN = 'AAAAAAAAAAAAAAAA';
const SECOND = 1_000;
const HOUR = 3_600_000;

function viewer(userId: string): AuthContext {
  return { userId, accountType: 'personal', familyId: 'f', emailVerified: true };
}

const PEOPLE: Record<string, NearbyRow> = {
  [A]: { id: A, handle: 'ana', name: 'Ana', avatarKey: null, connected: false },
  [B]: {
    id: B,
    handle: 'bia.alves',
    name: 'Bia Alves',
    avatarKey: 'avatars/b.jpg',
    connected: false,
  },
  [C]: { id: C, handle: 'caio', name: 'Caio', avatarKey: null, connected: true },
  [D]: { id: D, handle: 'duda', name: 'Duda', avatarKey: null, connected: false },
  [E]: { id: E, handle: 'enzo', name: 'Enzo', avatarKey: null, connected: false },
};

/** Store em memória em que cada operação pode falhar (Redis fora no meio, PROX-21, PROX-54). */
class SwitchableStore extends MemoryProximityStore {
  readonly failing = new Set<string>();

  private outage<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.failing.has(name) ? Promise.reject(new Error(`fora: ${name}`)) : operation();
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
  /** Contas que a política esconde de quem chama (bloqueio, criador, conta excluída). */
  const hidden = new Set<string>();
  const repository = {
    findNearby: vi.fn((_viewerId: string, ids: readonly string[]) =>
      Promise.resolve(ids.filter((id) => !hidden.has(id) && id in PEOPLE).map((id) => PEOPLE[id]!)),
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
    new AppConfig(testEnv(overrides)),
  );
  return { clock, store, hidden, repository, policy, media, service };
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

const NOTHING = { items: [] };

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
    // A política foi consultada uma vez, com quem chama e o dono do token.
    expect(t.repository.findNearby).toHaveBeenCalledTimes(1);
    expect(t.repository.findNearby).toHaveBeenLastCalledWith(B, [A, B], 'filtro-de-bloqueio');

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
    expect(t.repository.findNearby).toHaveBeenCalledTimes(1);
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

  it('[PROX-36] bloqueio, conta excluída e criador (a política esconde): sem cartão, sem par e sem cartão devido, nos dois lados', async () => {
    const t = setup();
    const claims = vi.spyOn(t.store, 'claimTouchPair');
    t.hidden.add(B);
    const { firstTokens, secondTokens, answer } = await touchPair(t, A, B);
    expect(answer).toEqual(NOTHING);
    expect(await t.service.touches(viewer(A), [secondTokens.bleToken])).toEqual(NOTHING);
    // Quem chama também precisa passar: sem a linha dele, também não casa.
    t.hidden.clear();
    t.hidden.add(A);
    expect(await t.service.touches(viewer(B), [firstTokens.bleToken])).toEqual(NOTHING);
    expect(await t.store.hasTouchPair(A, B)).toBe(false);
    expect(keys(t.store)).not.toContain(proximityKeys.owed(A));
    expect(keys(t.store)).not.toContain(proximityKeys.owed(B));
    // [PROX-46] A política vem antes do casamento: par recusado nunca toca os contadores.
    expect(claims).not.toHaveBeenCalled();
    expect(t.policy.hideBlockedFor).toHaveBeenCalled();
  });

  it('[PROX-36] sem a observação do outro na janela, nem o banco é consultado', async () => {
    const { service, repository } = setup();
    await service.issueToken(viewer(A));
    const b = await service.issueToken(viewer(B));
    await service.touches(viewer(A), [b.bleToken]);
    expect(repository.findNearby).not.toHaveBeenCalled();
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
  it('[PROX-49] M casa, recebe o cartão de V e bloqueia V: o relato seguinte de V recebe o cartão de M (do casamento, com o token relatado); o depois desse, nada', async () => {
    const t = setup();
    const { secondTokens: m, answer } = await touchPair(t, B, A);
    expect(answer.items).toEqual([expect.objectContaining({ handle: 'bia.alves' })]);
    // M bloqueia V: a política passa a esconder um do outro.
    t.hidden.add(A).add(B);

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
    // Entrega única: o relato seguinte não recebe de novo (e a política agora barra o casamento).
    t.clock.advance(SECOND);
    expect(await t.service.touches(viewer(B), [m.bleToken])).toEqual(NOTHING);
  });

  it('[PROX-50] M exclui a conta ou sai (tokens revogados): V relata o token revogado e recebe o cartão de M, sem ler o banco; depois de 60 s sem relato, nada', async () => {
    const t = setup();
    const { secondTokens: m } = await touchPair(t, B, A);
    // Exclusão ou logout de M: tokens revogados e a conta some da política.
    await t.store.revokeUser(A);
    t.hidden.add(A);
    const reads = t.repository.findNearby.mock.calls.length;

    await t.service.issueToken(viewer(B));
    const delivered = await t.service.touches(viewer(B), [m.bleToken]);
    expect(delivered.items).toEqual([
      expect.objectContaining({ token: m.bleToken, handle: 'ana', name: 'Ana' }),
    ]);
    expect(t.repository.findNearby.mock.calls.length).toBe(reads);

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
    expect(
      await Promise.all(claims.mock.results.map((result) => result.value as Promise<TouchClaim>)),
    ).toEqual(['created']);
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

  it('[PROX-60] o 61º relato no minuto com um cartão devido → 200 com o cartão, sem somar no limite; sem cartão, o mesmo relato dá 429', async () => {
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
  });

  it('[PROX-60] com a proximidade de V bloqueada (20 falhas) → 200 com o cartão; sem cartão, 429', async () => {
    const t = setup();
    const { m } = await owedToV(t);
    for (let index = 0; index < PROXIMITY_LIMITS.failures.limit; index++) {
      await t.service.recordFailure(viewer(B));
    }
    expect(await t.store.lockRemainingMs(B)).toBeGreaterThan(0);
    expect((await t.service.touches(viewer(B), [m.bleToken])).items).toEqual([
      expect.objectContaining({ handle: 'ana' }),
    ]);
    expect(await codeOf(t.service.touches(viewer(B), [m.bleToken]))).toBe(ErrorCode.RATE_LIMITED);
  });

  it('[PROX-60] sem prox:u (tela fechada) → 200 com o cartão; sem cartão, 409', async () => {
    const t = setup();
    const { m } = await owedToV(t);
    // A tela de V fechou (prox:u vence em 30 s); o cartão devido espera 60 s.
    t.clock.advance(30 * SECOND);
    expect(await t.store.isScreenOpen(B)).toBe(false);
    expect((await t.service.touches(viewer(B), [m.bleToken])).items).toEqual([
      expect.objectContaining({ token: m.bleToken, handle: 'ana' }),
    ]);
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

  it('[PROX-64] cartão devido que chega tarde (a pessoa voltou à tela aos 50 s) → 5; aos 55 s ou mais → 0, nunca negativo; relógio atrás do casamento → no máximo a validade', async () => {
    for (const [elapsed, expected] of [
      [5_000, 50],
      [50_000, 5],
      [54_999, 5],
      [55_000, 0],
      [59_999, 0],
      [-5_000, 60],
    ] as const) {
      const t = setup();
      const { m } = await marryAt(t);
      t.clock.advance(elapsed);
      const [owed] = (await t.service.touches(viewer(B), [m.bleToken])).items;
      expect(owed?.pairExpiresInS, `${String(elapsed)} ms`).toBe(expected);
    }
  });

  it('[PROX-64] a validade vem do env (PROX_TOUCH_PAIR_TTL_S)', async () => {
    const t = setup({ PROX_TOUCH_PAIR_TTL_S: '20' });
    const { m, card } = await marryAt(t);
    expect(card.pairExpiresInS).toBe(15);
    t.clock.advance(3_200);
    expect((await t.service.touches(viewer(B), [m.bleToken])).items[0]?.pairExpiresInS).toBe(15);
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
