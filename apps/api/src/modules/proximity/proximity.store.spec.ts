import { describe, expect, it, vi } from 'vitest';

import { PROXIMITY_LIMITS } from './proximity-token.js';
import {
  BLOCK_SIGNAL_SCRIPT,
  blockSignalDirection,
  CLAIM_TOUCH_SCRIPT,
  type ClaimTouchPairInput,
  MemoryProximityStore,
  proximityKeys,
  RedisProximityStore,
  TAKE_OWED_CARD_SCRIPT,
  TOUCH_SCRIPT,
  type TouchCard,
  type ProximityTokenRecord,
  type ProximityTtls,
} from './proximity.store.js';
import { FakeClock } from '../../testing/fake-clock.js';

const TTLS: ProximityTtls = { validMs: 30_000, recentMs: 120_000, screenMs: 30_000 };
const RECORD: ProximityTokenRecord = { userId: 'u1', issuedAt: 1, channel: 'ble' };
const QR_RECORD: ProximityTokenRecord = { userId: 'u1', issuedAt: 1, channel: 'qr' };
/** Janela do casamento (A2-2: 5 s desde o primeiro relato) e tempo de ocupado (2 × janela). */
const WINDOW_MS = 5_000;
const BUSY_MS = 10_000;
const PAIR_MS = 60_000;
const HOUR_MS = 3_600_000;

/** O mapa de valores do fake, para gravar um valor em formato antigo ou ilegível. */
function rawValues(store: MemoryProximityStore) {
  return (store as unknown as { values: Map<string, { value: string; expiresAt: number }> }).values;
}

function card(subjectId: string, atMs = 1): TouchCard {
  return {
    subjectId,
    atMs,
    handle: `h.${subjectId}`,
    name: `Nome ${subjectId}`,
    avatarKey: subjectId === 'b' ? 'avatars/b.jpg' : null,
    connected: false,
  };
}

/** `callerId` casa com `otherId` (teto 10/h e 30/dia, como o padrão). */
function claim(
  store: MemoryProximityStore,
  callerId: string,
  otherId: string,
  atMs: number,
  overrides: Partial<ClaimTouchPairInput> = {},
) {
  return store.claimTouchPair({
    callerId,
    otherId,
    atMs,
    pairTtlMs: PAIR_MS,
    windowMs: WINDOW_MS,
    busyMs: BUSY_MS,
    perHour: 10,
    perDay: 30,
    callerCard: card(callerId, atMs),
    ...overrides,
  });
}

/** O outro relatou quem chama (a observação que o casamento lê). */
async function observed(
  store: MemoryProximityStore,
  otherId: string,
  callerId: string,
  at: number,
) {
  await store.recordTouch(otherId, callerId, `hash-de-${callerId}`, at, WINDOW_MS);
}

describe('MemoryProximityStore (validades sobre o Clock)', () => {
  it('[PROX-02] [PROX-03] válido até 30 s, recente até 120 s, tela aberta até 30 s', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    await store.issue('h1', RECORD, TTLS);
    expect(await store.findValid(['h1', 'outro'])).toEqual([RECORD, null]);
    expect(await store.isScreenOpen('u1')).toBe(true);

    clock.advance(29_999);
    expect(await store.findValid(['h1'])).toEqual([RECORD]);
    clock.advance(1);
    expect(await store.findValid(['h1'])).toEqual([null]);
    expect(await store.isScreenOpen('u1')).toBe(false);
    expect(await store.findRecent('h1')).toEqual(RECORD);

    clock.advance(90_000);
    expect(await store.findRecent('h1')).toBeNull();
  });

  it('[PROX-01] ADR 0012: o canal fica no registro, e os dois tokens da emissão são independentes', async () => {
    const store = new MemoryProximityStore(new FakeClock());
    await store.issue('hb', RECORD, TTLS);
    await store.issue('hq', QR_RECORD, TTLS);
    expect(await store.findValid(['hb', 'hq'])).toEqual([RECORD, QR_RECORD]);
    expect(await store.findRecent('hq')).toEqual(QR_RECORD);
    expect(store.entries()).toContainEqual({
      key: proximityKeys.valid('hb'),
      value: '{"uid":"u1","iat":1,"ch":"ble"}',
    });
    expect(store.entries()).toContainEqual({
      key: proximityKeys.issued('u1'),
      value: 'hb,hq',
    });
  });

  it('[PROX-27] revokeUser apaga todos os tokens emitidos pela conta e a tela aberta', async () => {
    const store = new MemoryProximityStore(new FakeClock());
    const other: ProximityTokenRecord = { userId: 'u2', issuedAt: 1, channel: 'ble' };
    await store.issue('h1', RECORD, TTLS);
    await store.issue('h2', QR_RECORD, TTLS);
    await store.issue('h3', other, TTLS);
    await store.revokeUser('u1');
    expect(await store.findValid(['h1', 'h2', 'h3'])).toEqual([null, null, other]);
    expect(await store.findRecent('h1')).toBeNull();
    expect(await store.findRecent('h2')).toBeNull();
    expect(await store.isScreenOpen('u1')).toBe(false);
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.issued('u1'));
  });

  it('contador de janela fixa e bloqueio com tempo restante', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    expect(await store.hit('k', 1_000)).toEqual({ count: 1, resetInMs: 1_000 });
    clock.advance(400);
    expect(await store.hit('k', 1_000)).toEqual({ count: 2, resetInMs: 600 });
    clock.advance(600);
    expect(await store.hit('k', 1_000)).toEqual({ count: 1, resetInMs: 1_000 });

    expect(await store.lockRemainingMs('u1')).toBe(0);
    await store.lock('u1', 900_000);
    clock.advance(100_000);
    expect(await store.lockRemainingMs('u1')).toBe(800_000);
    clock.advance(800_000);
    expect(await store.lockRemainingMs('u1')).toBe(0);
  });

  it('[PROX-32] recordTouch: o primeiro relato não está na janela de ninguém; o recíproco dentro da janela está', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    expect(await store.recordTouch('a', 'b', 'hb', at, WINDOW_MS)).toBe(false);
    clock.advance(1_000);
    expect(await store.recordTouch('b', 'a', 'ha', at + 1_000, WINDOW_MS)).toBe(true);
    clock.advance(1_000);
    expect(await store.recordTouch('a', 'b', 'hb', at + 2_000, WINDOW_MS)).toBe(true);
    // Uma terceira conta não casa com ninguém: a observação é por par ordenado.
    expect(await store.recordTouch('c', 'a', 'ha', at + 2_000, WINDOW_MS)).toBe(false);
  });

  it('[PROX-48] recordTouch com prazo deslizante (A2 rev. 1, R1-1): todo relato regrava a chave por 2 × janela desde ele, mantendo o primeiroMs e trocando o hash', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    const key = proximityKeys.touch('a', 'b');
    const expiresAt = () => rawValues(store).get(key)?.expiresAt;
    await store.recordTouch('a', 'b', 'h1', at, WINDOW_MS);
    expect(store.entries()).toContainEqual({ key, value: `${String(at)}:h1` });
    expect(expiresAt()).toBe(at + 2 * WINDOW_MS);

    clock.advance(4_000);
    await store.recordTouch('a', 'b', 'h2', at + 4_000, WINDOW_MS);
    // O hash muda; o horário continua o do primeiro relato; o prazo conta deste relato (sem KEEPTTL).
    expect(store.entries()).toContainEqual({ key, value: `${String(at)}:h2` });
    expect(expiresAt()).toBe(at + 4_000 + 2 * WINDOW_MS);

    // 9,999 s sem relato: a chave vive, e o relato seguinte mantém o primeiroMs.
    clock.advance(2 * WINDOW_MS - 1);
    expect(store.entries().map((entry) => entry.key)).toContain(key);
    await store.recordTouch('a', 'b', 'h3', at + 4_000 + 2 * WINDOW_MS - 1, WINDOW_MS);
    expect(store.entries()).toContainEqual({ key, value: `${String(at)}:h3` });

    // 10 s sem relato: a chave some, e o relato seguinte abre outra janela.
    const last = at + 4_000 + 2 * WINDOW_MS - 1;
    clock.advance(2 * WINDOW_MS);
    expect(store.entries().map((entry) => entry.key)).not.toContain(key);
    await store.recordTouch('a', 'b', 'h4', last + 2 * WINDOW_MS, WINDOW_MS);
    expect(store.entries()).toContainEqual({
      key,
      value: `${String(last + 2 * WINDOW_MS)}:h4`,
    });
  });

  it('[PROX-48] relatos a 1/s por 30 s: o primeiroMs continua o do 1º, e o outro nunca casa depois dos 5 s (a janela não reabre enquanto o observador relata)', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const key = proximityKeys.touch('a', 'b');
    for (let second = 0; second <= 30; second++) {
      clock.set(new Date(second * 1_000));
      await store.recordTouch('a', 'b', `h${String(second)}`, second * 1_000, WINDOW_MS);
      expect(store.entries()).toContainEqual({ key, value: `0:h${String(second)}` });
      // O outro relata a cada segundo a partir dos 5 s: nunca casa com a observação de a.
      if (second >= 5) {
        expect(await store.recordTouch('b', 'a', 'ha', second * 1_000, WINDOW_MS)).toBe(false);
      }
    }
  });

  it('[PROX-48] janela do primeiro relato: casa com 4,999 s, não casa com 5 s, mesmo com o outro relatando o tempo todo', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    await store.recordTouch('a', 'b', 'hb', 0, WINDOW_MS);
    clock.advance(WINDOW_MS - 1);
    expect(await store.recordTouch('b', 'a', 'ha', WINDOW_MS - 1, WINDOW_MS)).toBe(true);

    const later = new MemoryProximityStore(clock);
    await later.recordTouch('a', 'b', 'hb', 0, WINDOW_MS);
    // a relata de novo a cada segundo: a janela não reabre.
    for (let second = 1; second < 5; second++) {
      await later.recordTouch('a', 'b', 'hb', second * 1_000, WINDOW_MS);
    }
    expect(await later.recordTouch('b', 'a', 'ha', WINDOW_MS, WINDOW_MS)).toBe(false);
    expect(await later.recordTouch('b', 'a', 'ha', 9_999, WINDOW_MS)).toBe(false);
  });

  it('[PROX-48] observação em formato antigo (só o horário) ou ilegível: não existe (fecha) e é regravada no formato novo', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    // O valor de antes do A2 (só o horário), escrito direto no mapa do fake.
    rawValues(store).set(proximityKeys.touch('b', 'a'), {
      value: String(at),
      expiresAt: at + 10_000,
    });
    expect(await store.recordTouch('a', 'b', 'hb', at, WINDOW_MS)).toBe(false);
    expect(await store.recordTouch('b', 'a', 'ha', at, WINDOW_MS)).toBe(true);
    expect(store.entries()).toContainEqual({
      key: proximityKeys.touch('b', 'a'),
      value: `${String(at)}:ha`,
    });
  });

  it('[PROX-32] par encostado: mesma chave nos dois sentidos, vale 60 s e é renovado a cada casamento', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    expect(await store.hasTouchPair('a', 'b')).toBe(false);
    await store.markTouchPair('b', 'a', PAIR_MS, 5);
    expect(await store.hasTouchPair('a', 'b')).toBe(true);
    expect(await store.hasTouchPair('b', 'a')).toBe(true);
    expect(await store.hasTouchPair('a', 'c')).toBe(false);
    expect(store.entries()).toContainEqual({ key: 'prox:m:a:b', value: '5' });

    clock.advance(PAIR_MS - 1);
    expect(await store.hasTouchPair('a', 'b')).toBe(true);
    await store.markTouchPair('a', 'b', PAIR_MS, 6);
    clock.advance(PAIR_MS - 1);
    expect(await store.hasTouchPair('a', 'b')).toBe(true);
    clock.advance(1);
    expect(await store.hasTouchPair('a', 'b')).toBe(false);
  });

  it('[PROX-49] claimTouchPair: grava o par (60 s), o cartão de quem chama devido ao outro com o hash da observação dele (60 s) e marca quem chama como ocupado (10 s)', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    await observed(store, 'a', 'b', at);
    expect(await claim(store, 'b', 'a', at + 800)).toBe('created');

    expect(await store.hasTouchPair('a', 'b')).toBe(true);
    expect(store.entries()).toContainEqual({
      key: proximityKeys.owed('a'),
      value: `hash-de-b|{"s":"b","at":${String(at + 800)},"h":"h.b","n":"Nome b","a":"avatars/b.jpg","c":false}`,
    });
    expect(store.entries()).toContainEqual({ key: proximityKeys.busy('b'), value: '1' });
    // Quem chama não fica com cartão devido (recebe o do outro na resposta), e o outro não fica
    // ocupado antes de receber.
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.owed('b'));
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.busy('a'));

    clock.advance(BUSY_MS - 1);
    expect(store.entries().map((entry) => entry.key)).toContain(proximityKeys.busy('b'));
    clock.advance(1);
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.busy('b'));
    clock.advance(PAIR_MS - BUSY_MS - 1);
    expect(store.entries().map((entry) => entry.key)).toContain(proximityKeys.owed('a'));
    clock.advance(1);
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.owed('a'));
    expect(await store.hasTouchPair('a', 'b')).toBe(false);
  });

  it('[PROX-48] claimTouchPair: sem a observação do outro, ilegível ou com o primeiro relato a 5 s ou mais → gone, sem gravar nada', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    expect(await claim(store, 'b', 'a', at)).toBe('gone');

    await observed(store, 'a', 'b', at);
    expect(await claim(store, 'b', 'a', at + WINDOW_MS)).toBe('gone');
    rawValues(store).set(proximityKeys.touch('c', 'b'), { value: 'lixo', expiresAt: at + 10_000 });
    expect(await claim(store, 'b', 'c', at)).toBe('gone');
    expect(store.entries().map((entry) => entry.key)).toEqual([
      proximityKeys.touch('a', 'b'),
      proximityKeys.touch('c', 'b'),
    ]);
    // 4,999 s: ainda casa.
    expect(await claim(store, 'b', 'a', at + WINDOW_MS - 1)).toBe('created');
  });

  it('[PROX-53] ocupado: com um cartão a receber ou a marca de ocupado de qualquer um dos dois, ninguém casa (busy), sem gravar nem contar; o cartão devido nunca é sobrescrito', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    // M casa com V: V fica com o cartão de M a receber; M, ocupado.
    await observed(store, 'v', 'm', at);
    expect(await claim(store, 'm', 'v', at)).toBe('created');
    const owedToV = store.entries().find((entry) => entry.key === proximityKeys.owed('v'));

    // X tenta casar com V (V tem cartão a receber) e com M (M está ocupado), nos dois sentidos.
    await observed(store, 'v', 'x', at);
    expect(await claim(store, 'x', 'v', at)).toBe('busy');
    await observed(store, 'x', 'v', at);
    expect(await claim(store, 'v', 'x', at)).toBe('busy');
    await observed(store, 'm', 'x', at);
    expect(await claim(store, 'x', 'm', at)).toBe('busy');
    await observed(store, 'x', 'm', at);
    expect(await claim(store, 'm', 'x', at)).toBe('busy');
    expect(await store.hasTouchPair('v', 'x')).toBe(false);
    expect(await store.hasTouchPair('m', 'x')).toBe(false);
    expect(store.entries().find((entry) => entry.key === proximityKeys.owed('v'))).toEqual(owedToV);
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.owed('x'));
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.busy('x'));

    // V recebe o cartão: fica ocupado 10 s; depois, casa com Y.
    expect(await store.takeOwedCard('v', BUSY_MS)).not.toBeNull();
    clock.advance(BUSY_MS - 1);
    await observed(store, 'y', 'v', at + BUSY_MS - 1);
    expect(await claim(store, 'v', 'y', at + BUSY_MS - 1)).toBe('busy');
    clock.advance(1);
    expect(await claim(store, 'v', 'y', at + BUSY_MS)).toBe('created');
  });

  it('[PROX-45] teto: par novo soma 1 nos quatro contadores (hora e dia dos dois); renovar não conta; no teto de qualquer um dos dois → capped, sem par, sem cartão e sem somar', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    let at = clock.now().getTime();
    const tick = (ms: number) => {
      clock.advance(ms);
      at += ms;
    };
    // a casa com 3 pessoas novas (teto 3/h para o teste); cada casamento, depois do ocupado.
    for (const other of ['p1', 'p2', 'p3']) {
      await observed(store, other, 'a', at);
      expect(await claim(store, 'a', other, at, { perHour: 3 })).toBe('created');
      await store.forgetTouchState(other);
      tick(BUSY_MS);
    }
    // Renovar o par com p1 (vivo) não conta.
    await observed(store, 'p1', 'a', at);
    expect(await claim(store, 'a', 'p1', at, { perHour: 3 })).toBe('renewed');
    await store.forgetTouchState('p1');
    tick(BUSY_MS);
    // O 4º par novo de a: capped, e nada é gravado.
    await observed(store, 'p4', 'a', at);
    expect(await claim(store, 'a', 'p4', at, { perHour: 3 })).toBe('capped');
    expect(await store.hasTouchPair('a', 'p4')).toBe(false);
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.owed('p4'));
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.busy('a'));
    // Vale para os dois lados: p4 chamando também não casa com a.
    await observed(store, 'a', 'p4', at);
    expect(await claim(store, 'p4', 'a', at, { perHour: 3 })).toBe('capped');
    // p4 não somou nada nas tentativas barradas: casa 3 vezes com outras pessoas.
    for (const other of ['q1', 'q2', 'q3']) {
      await observed(store, other, 'p4', at);
      expect(await claim(store, 'p4', other, at, { perHour: 3 })).toBe('created');
      await store.forgetTouchState(other);
      tick(BUSY_MS);
    }
    await observed(store, 'q4', 'p4', at);
    expect(await claim(store, 'p4', 'q4', at, { perHour: 3 })).toBe('capped');

    // A hora seguinte libera a (a janela fixa começou no primeiro par novo dele).
    tick(HOUR_MS);
    await observed(store, 'p5', 'a', at);
    expect(await claim(store, 'a', 'p5', at, { perHour: 3 })).toBe('created');
  });

  it('[PROX-45] teto por dia: com 2/h e 3/dia, o 4º par novo do dia continua barrado na hora seguinte; o dia seguinte libera', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    let at = clock.now().getTime();
    const tick = (ms: number) => {
      clock.advance(ms);
      at += ms;
    };
    const limits = { perHour: 2, perDay: 3 };
    const results: string[] = [];
    for (const other of ['p1', 'p2', 'p3', 'p4']) {
      await observed(store, other, 'a', at);
      results.push(await claim(store, 'a', other, at, limits));
      await store.forgetTouchState(other);
      tick(BUSY_MS);
    }
    // p3 já esbarra no teto da hora (2); p4 também.
    expect(results).toEqual(['created', 'created', 'capped', 'capped']);
    tick(HOUR_MS);
    await observed(store, 'p3', 'a', at);
    expect(await claim(store, 'a', 'p3', at, limits)).toBe('created');
    await store.forgetTouchState('p3');
    tick(BUSY_MS);
    await observed(store, 'p4', 'a', at);
    expect(await claim(store, 'a', 'p4', at, limits)).toBe('capped');
    tick(24 * HOUR_MS);
    await observed(store, 'p4', 'a', at);
    expect(await claim(store, 'a', 'p4', at, limits)).toBe('created');
  });

  it('[PROX-67] [PROX-49] [PROX-43] takeOwedCard (A3-2): a 1ª retirada devolve o cartão (redelivered false), grava "!{hash}|{json}" com prazo de 10 s e o ocupado por 10 s; a retirada em menos de 10 s devolve o mesmo cartão (redelivered true), sem mudar prazo nem ocupado; aos 10 s, nada; sem cartão → null e nada muda', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    const expiry = (key: string) => rawValues(store).get(key)?.expiresAt;
    expect(await store.takeOwedCard('a', BUSY_MS)).toBeNull();
    expect(store.entries()).toEqual([]);

    await observed(store, 'a', 'b', at);
    await claim(store, 'b', 'a', at);
    const value = `hash-de-b|{"s":"b","at":${String(at)},"h":"h.b","n":"Nome b","a":"avatars/b.jpg","c":false}`;
    expect(store.entries()).toContainEqual({ key: proximityKeys.owed('a'), value });
    const card = {
      tokenHash: 'hash-de-b',
      subjectId: 'b',
      atMs: at,
      handle: 'h.b',
      name: 'Nome b',
      avatarKey: 'avatars/b.jpg',
      connected: false,
    };

    clock.advance(1_000);
    expect(await store.takeOwedCard('a', BUSY_MS)).toEqual({ ...card, redelivered: false });
    expect(store.entries()).toContainEqual({ key: proximityKeys.owed('a'), value: `!${value}` });
    expect(store.entries()).toContainEqual({ key: proximityKeys.busy('a'), value: '1' });
    const delivered = at + 1_000;
    expect(expiry(proximityKeys.owed('a'))).toBe(delivered + BUSY_MS);
    expect(expiry(proximityKeys.busy('a'))).toBe(delivered + BUSY_MS);

    // A reentrega: o mesmo cartão, sem regravar nada (o mesmo prazo e o mesmo ocupado).
    for (const elapsed of [1, 5_000, BUSY_MS - 1]) {
      clock.set(new Date(delivered + elapsed));
      expect(await store.takeOwedCard('a', BUSY_MS)).toEqual({ ...card, redelivered: true });
      expect(store.entries()).toContainEqual({ key: proximityKeys.owed('a'), value: `!${value}` });
      expect(expiry(proximityKeys.owed('a'))).toBe(delivered + BUSY_MS);
      expect(expiry(proximityKeys.busy('a'))).toBe(delivered + BUSY_MS);
    }

    clock.set(new Date(delivered + BUSY_MS));
    expect(await store.takeOwedCard('a', BUSY_MS)).toBeNull();
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.owed('a'));
    expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.busy('a'));
  });

  it('[PROX-67] takeOwedCard: o cartão com menos de 10 s de vida não ganha prazo (min(o que falta, 10 s)); o ocupado dura os 10 s', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    const expiry = (key: string) => rawValues(store).get(key)?.expiresAt;
    await observed(store, 'a', 'b', at);
    await claim(store, 'b', 'a', at);

    clock.advance(PAIR_MS - 3_000);
    expect((await store.takeOwedCard('a', BUSY_MS))?.redelivered).toBe(false);
    expect(expiry(proximityKeys.owed('a'))).toBe(at + PAIR_MS);
    expect(expiry(proximityKeys.busy('a'))).toBe(at + PAIR_MS - 3_000 + BUSY_MS);
    clock.advance(2_999);
    expect((await store.takeOwedCard('a', BUSY_MS))?.redelivered).toBe(true);
    clock.advance(1);
    expect(await store.takeOwedCard('a', BUSY_MS)).toBeNull();
    expect(store.entries().map((entry) => entry.key)).toContain(proximityKeys.busy('a'));
  });

  it('[PROX-67] [PROX-49] takeOwedCard: valor ilegível → null, sem apagar (como o script, que não lê o JSON: marcado e com o ocupado, vence em até 10 s)', async () => {
    for (const value of ['sem-separador', '|{"s":"b"}', 'h|não é json', 'h|{"s":"b","at":1}']) {
      const clock = new FakeClock();
      const store = new MemoryProximityStore(clock);
      const at = clock.now().getTime();
      rawValues(store).set(proximityKeys.owed('c'), { value, expiresAt: at + PAIR_MS });
      expect(await store.takeOwedCard('c', BUSY_MS), value).toBeNull();
      expect(store.entries()).toContainEqual({ key: proximityKeys.owed('c'), value: `!${value}` });
      expect(store.entries()).toContainEqual({ key: proximityKeys.busy('c'), value: '1' });
      expect(await store.takeOwedCard('c', BUSY_MS), value).toBeNull();
      clock.advance(BUSY_MS - 1);
      expect(store.entries().map((entry) => entry.key)).toContain(proximityKeys.owed('c'));
      clock.advance(1);
      expect(store.entries().map((entry) => entry.key)).not.toContain(proximityKeys.owed('c'));
    }
  });

  it('[PROX-67] [PROX-53] o cartão à espera da reentrega ("!") ocupa a conta sozinho, mesmo sem o prox:c: ninguém casa com ela, e ela não casa com ninguém, até ele vencer', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    await observed(store, 'v', 'm', at);
    expect(await claim(store, 'm', 'v', at)).toBe('created');
    expect((await store.takeOwedCard('v', BUSY_MS))?.redelivered).toBe(false);
    rawValues(store).delete(proximityKeys.busy('v'));

    await observed(store, 'v', 'x', at);
    expect(await claim(store, 'x', 'v', at)).toBe('busy');
    await observed(store, 'x', 'v', at);
    expect(await claim(store, 'v', 'x', at)).toBe('busy');
    clock.advance(BUSY_MS);
    await observed(store, 'v', 'x', at + BUSY_MS);
    expect(await claim(store, 'x', 'v', at + BUSY_MS)).toBe('created');
  });

  it('[PROX-66] [PROX-46] claimTouchPair com callerCard nulo (a política recusou, A3-1): refused logo depois do gone, sem ler nem gravar par, contadores, cartão devido ou ocupado', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    const internals = store as unknown as {
      read: (key: string) => string | null;
      count: (key: string) => number;
      counters: Map<string, { count: number; resetAt: number }>;
    };
    const snapshot = () => ({
      values: [...rawValues(store)].map(([key, entry]) => [key, { ...entry }]),
      counters: [...internals.counters].map(([key, entry]) => [key, { ...entry }]),
    });
    // Sem a observação do outro, ou fora da janela: `gone`, como sempre (o passo 1 vem antes).
    expect(await claim(store, 'b', 'a', at, { callerCard: null })).toBe('gone');
    await observed(store, 'a', 'b', at);
    expect(await claim(store, 'b', 'a', at + WINDOW_MS, { callerCard: null })).toBe('gone');

    // b com par vivo com a, ocupado, com contadores e um cartão devido a p: nada disso é lido.
    await store.markTouchPair('a', 'b', PAIR_MS, 7);
    await observed(store, 'p', 'b', at);
    expect(await claim(store, 'b', 'p', at)).toBe('created');
    const before = snapshot();
    const reads = vi.spyOn(internals, 'read');
    const counts = vi.spyOn(internals, 'count');

    clock.advance(1);
    expect(await claim(store, 'b', 'a', at + 1, { callerCard: null })).toBe('refused');
    expect(reads.mock.calls).toEqual([[proximityKeys.touch('a', 'b')]]);
    expect(counts).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(store.entries()).toContainEqual({ key: proximityKeys.pair('a', 'b'), value: '7' });

    // Com o cartão, o mesmo relato seguiria para o ocupado (b recebeu um cartão há pouco).
    expect(await claim(store, 'b', 'a', at + 1)).toBe('busy');
  });

  it('[PROX-42] forgetTouchState (só dev): apaga o cartão devido e a marca de ocupado da conta, e nada mais', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    const at = clock.now().getTime();
    await observed(store, 'p', 'a', at);
    await claim(store, 'a', 'p', at);
    await store.forgetTouchState('a');
    await store.forgetTouchState('p');
    expect(store.entries().map((entry) => entry.key)).toEqual([
      proximityKeys.touch('p', 'a'),
      proximityKeys.pair('a', 'p'),
    ]);
  });

  it('[PROX-43] nenhuma chave do encosto guarda dado de sinal nem token em claro: ids na chave; horário e hash na observação; cartão e "1" no devido e no ocupado', async () => {
    const clock = new FakeClock();
    const store = new MemoryProximityStore(clock);
    await store.recordTouch('a', 'b', 'hb', 123, WINDOW_MS);
    await store.recordTouch('b', 'a', 'ha', 124, WINDOW_MS);
    await claim(store, 'b', 'a', 124);
    expect(store.entries()).toEqual([
      { key: 'prox:o:a:b', value: '123:hb' },
      { key: 'prox:o:b:a', value: '124:ha' },
      { key: 'prox:m:a:b', value: '124' },
      {
        key: 'prox:v:a',
        value: 'hb|{"s":"b","at":124,"h":"h.b","n":"Nome b","a":"avatars/b.jpg","c":false}',
      },
      { key: 'prox:c:b', value: '1' },
    ]);
    // A2 rev. 1 (R1-6): depois de um bloqueio entre os dois, o par guarda o sentido contado.
    await store.countBlockSignal('b', 'a', 7 * 24 * HOUR_MS);
    expect(store.entries()).toContainEqual({ key: 'prox:m:a:b', value: '124:b' });
    await store.countBlockSignal('a', 'b', 7 * 24 * HOUR_MS);
    expect(store.entries()).toContainEqual({ key: 'prox:m:a:b', value: '124:ba' });
  });

  describe('countBlockSignal (A2 rev. 1, R1-6)', () => {
    const SEVEN_DAYS = 7 * 24 * HOUR_MS;
    /** Contadores do fake (o `rl:` fica fora do `entries()`). */
    function counters(store: MemoryProximityStore) {
      return (store as unknown as { counters: Map<string, { count: number; resetAt: number }> })
        .counters;
    }
    function count(store: MemoryProximityStore, key: string) {
      return counters(store).get(key)?.count ?? 0;
    }

    it('[PROX-63] sem par → null, sem marcar nem somar; com o par, marca o sentido no valor (sem mudar o prazo) e soma 1 nos dois contadores', async () => {
      const clock = new FakeClock();
      const store = new MemoryProximityStore(clock);
      expect(await store.countBlockSignal('a', 'b', SEVEN_DAYS)).toBeNull();
      expect(counters(store).size).toBe(0);
      expect(store.entries()).toEqual([]);

      await store.markTouchPair('a', 'b', PAIR_MS, 5);
      clock.advance(1_000);
      const expiresAt = rawValues(store).get('prox:m:a:b')?.expiresAt;
      // 'a' é o menor id do par e bloqueou o maior: sentido `a`.
      expect(await store.countBlockSignal('a', 'b', SEVEN_DAYS)).toEqual({
        blocker: 1,
        blocked: 1,
      });
      expect(store.entries()).toContainEqual({ key: 'prox:m:a:b', value: '5:a' });
      expect(rawValues(store).get('prox:m:a:b')?.expiresAt).toBe(expiresAt);
      expect(count(store, proximityKeys.blockSignal('blocker', 'a'))).toBe(1);
      expect(count(store, proximityKeys.blockSignal('blocked', 'b'))).toBe(1);
      // O par continua vivo para o pedido, o bloqueio e a denúncia (não é consumido).
      expect(await store.hasTouchPair('b', 'a')).toBe(true);
      // E vence no mesmo horário de antes.
      clock.advance(PAIR_MS - 1_000 - 1);
      expect(await store.hasTouchPair('a', 'b')).toBe(true);
      clock.advance(1);
      expect(await store.hasTouchPair('a', 'b')).toBe(false);
      expect(await store.countBlockSignal('a', 'b', SEVEN_DAYS)).toBeNull();
    });

    it('[PROX-63] uma vez por casamento e por sentido: repetir o mesmo sentido → null; o outro sentido conta uma vez; o casamento novo (claim ou markTouchPair) limpa as marcas', async () => {
      const clock = new FakeClock();
      const store = new MemoryProximityStore(clock);
      const at = clock.now().getTime();
      await observed(store, 'a', 'b', at);
      expect(await claim(store, 'b', 'a', at)).toBe('created');

      // b (o maior) bloqueia a cinco vezes (bloquear, desbloquear e bloquear de novo): soma 1.
      const results = [];
      for (let index = 0; index < 5; index++) {
        results.push(await store.countBlockSignal('b', 'a', SEVEN_DAYS));
      }
      expect(results).toEqual([{ blocker: 1, blocked: 1 }, null, null, null, null]);
      expect(store.entries()).toContainEqual({ key: 'prox:m:a:b', value: `${String(at)}:b` });
      // a também bloqueia b: conta uma vez no sentido dele.
      expect(await store.countBlockSignal('a', 'b', SEVEN_DAYS)).toEqual({
        blocker: 1,
        blocked: 1,
      });
      expect(await store.countBlockSignal('a', 'b', SEVEN_DAYS)).toBeNull();
      expect(store.entries()).toContainEqual({ key: 'prox:m:a:b', value: `${String(at)}:ba` });
      expect(count(store, proximityKeys.blockSignal('blocker', 'b'))).toBe(1);
      expect(count(store, proximityKeys.blockSignal('blocked', 'a'))).toBe(1);
      expect(count(store, proximityKeys.blockSignal('blocker', 'a'))).toBe(1);
      expect(count(store, proximityKeys.blockSignal('blocked', 'b'))).toBe(1);

      // Renovação (casamento com o par vivo, depois do ocupado): o par volta a ser só o horário,
      // o casamento continua "renewed" (o par com marcas existe) e o sinal pode contar de novo.
      await store.takeOwedCard('a', BUSY_MS);
      clock.advance(BUSY_MS);
      await observed(store, 'b', 'a', at + BUSY_MS);
      expect(await claim(store, 'a', 'b', at + BUSY_MS)).toBe('renewed');
      expect(store.entries()).toContainEqual({
        key: 'prox:m:a:b',
        value: String(at + BUSY_MS),
      });
      expect(await store.countBlockSignal('b', 'a', SEVEN_DAYS)).toEqual({
        blocker: 2,
        blocked: 2,
      });

      // O markTouchPair (só o /dev/simulate-request) também regrava só o horário.
      await store.markTouchPair('a', 'b', PAIR_MS, 99);
      expect(await store.countBlockSignal('b', 'a', SEVEN_DAYS)).toEqual({
        blocker: 3,
        blocked: 3,
      });
    });

    it('[PROX-63] uma pessoa sozinha não leva outra a 3 sem 3 casamentos; os contadores são de janela fixa de 7 dias; valor ilegível do par → null', async () => {
      const clock = new FakeClock();
      const store = new MemoryProximityStore(clock);
      await store.markTouchPair('v', 'm', PAIR_MS, 1);
      for (let index = 0; index < 10; index++) {
        await store.countBlockSignal('v', 'm', SEVEN_DAYS);
      }
      expect(count(store, proximityKeys.blockSignal('blocked', 'm'))).toBe(1);

      // Outras duas pessoas, cada uma no próprio casamento: o blocked de m chega a 3.
      await store.markTouchPair('x', 'm', PAIR_MS, 1);
      await store.markTouchPair('y', 'm', PAIR_MS, 1);
      expect((await store.countBlockSignal('x', 'm', SEVEN_DAYS))?.blocked).toBe(2);
      expect((await store.countBlockSignal('y', 'm', SEVEN_DAYS))?.blocked).toBe(3);

      // A janela abriu no primeiro e dura 7 dias.
      clock.advance(SEVEN_DAYS - 1);
      await store.markTouchPair('z', 'm', PAIR_MS, 2);
      expect((await store.countBlockSignal('z', 'm', SEVEN_DAYS))?.blocked).toBe(4);
      clock.advance(1);
      await store.markTouchPair('w', 'm', PAIR_MS, 3);
      expect((await store.countBlockSignal('w', 'm', SEVEN_DAYS))?.blocked).toBe(1);

      for (const value of ['lixo', '12:c', ':a', '12:a:b']) {
        rawValues(store).set('prox:m:k:l', { value, expiresAt: clock.now().getTime() + PAIR_MS });
        expect(await store.countBlockSignal('k', 'l', SEVEN_DAYS)).toBeNull();
        expect(store.entries()).toContainEqual({ key: 'prox:m:k:l', value });
      }
      expect(count(store, proximityKeys.blockSignal('blocker', 'k'))).toBe(0);
    });
  });
});

describe('proximityKeys (arquitetura.md §6, ADR 0012)', () => {
  it('[PROX-43] observação por par ordenado e par com o menor id primeiro', () => {
    expect(proximityKeys.touch('obs', 'dono')).toBe('prox:o:obs:dono');
    const low = '01a189e0-af57-7000-85fe-2054e618fe0a';
    const high = '01a189e0-af57-7000-85fe-2054e618fe0b';
    expect(proximityKeys.pair(low, high)).toBe(`prox:m:${low}:${high}`);
    expect(proximityKeys.pair(high, low)).toBe(`prox:m:${low}:${high}`);
  });

  it('[PROX-43] [PROX-45] A2: cartão devido, ocupado e os contadores do teto, por conta', () => {
    expect(proximityKeys.owed('u')).toBe('prox:v:u');
    expect(proximityKeys.busy('u')).toBe('prox:c:u');
    expect(proximityKeys.pairsPerHour('u')).toBe('rl:prox-pairs:hour:u');
    expect(proximityKeys.pairsPerDay('u')).toBe('rl:prox-pairs:day:u');
  });

  it('[PROX-43] [PROX-63] A2 rev. 1: contadores do sinal com os nomes de antes, e o sentido segue a ordem da chave do par', () => {
    expect(proximityKeys.blockSignal('blocker', 'u')).toBe(
      `rl:${PROXIMITY_LIMITS.blockAfterTouch.name}:blocker:u`,
    );
    expect(proximityKeys.blockSignal('blocked', 'u')).toBe('rl:prox-block-after-touch:blocked:u');
    const low = '01a189e0-af57-7000-85fe-2054e618fe0a';
    const high = '01a189e0-af57-7000-85fe-2054e618fe0b';
    // `a` = o menor id (o primeiro da chave do par) bloqueou o maior.
    expect(proximityKeys.pair(high, low).startsWith(`prox:m:${low}:`)).toBe(true);
    expect(blockSignalDirection(low, high)).toBe('a');
    expect(blockSignalDirection(high, low)).toBe('b');
  });
});

describe('RedisProximityStore (comandos)', () => {
  function fakeRedis(execResult: [Error | null, unknown][] | null = []) {
    const calls: unknown[][] = [];
    const chain = {
      set: (...args: unknown[]) => (calls.push(['set', ...args]), chain),
      sadd: (...args: unknown[]) => (calls.push(['sadd', ...args]), chain),
      pexpire: (...args: unknown[]) => (calls.push(['pexpire', ...args]), chain),
      exec: () => Promise.resolve(execResult),
    };
    const redis = {
      multi: () => chain,
      mget: vi.fn((...keys: string[]) =>
        Promise.resolve(
          keys.map((key) => {
            if (key === 'prox:t:h1') return '{"uid":"u1","iat":7,"ch":"ble"}';
            if (key === 'prox:t:hq') return '{"uid":"u1","iat":7,"ch":"qr"}';
            // Registro sem canal (anterior à ADR 0012) ou com canal desconhecido: não vale.
            if (key === 'prox:t:old') return '{"uid":"u1","iat":7}';
            if (key === 'prox:t:nfc') return '{"uid":"u1","iat":7,"ch":"nfc"}';
            return null;
          }),
        ),
      ),
      get: vi.fn(() => Promise.resolve('não é json')),
      exists: vi.fn(() => Promise.resolve(1)),
      smembers: vi.fn(() => Promise.resolve(['h1', 'h2'])),
      del: vi.fn(() => Promise.resolve(6)),
      set: vi.fn(() => Promise.resolve('OK')),
      pttl: vi.fn(() => Promise.resolve(-2)),
      eval: vi.fn(() => Promise.resolve([3, 500])),
    };
    return { redis, calls };
  }

  it('[PROX-01] grava só o hash, com o canal no registro, PX de 30/120/30 s, e indexa o hash na conta', async () => {
    const { redis, calls } = fakeRedis();
    await new RedisProximityStore(redis as never).issue('h1', RECORD, TTLS);
    expect(calls).toEqual([
      ['set', 'prox:t:h1', '{"uid":"u1","iat":1,"ch":"ble"}', 'PX', 30_000],
      ['set', 'prox:r:h1', '{"uid":"u1","iat":1,"ch":"ble"}', 'PX', 120_000],
      ['set', 'prox:u:u1', 'h1', 'PX', 30_000],
      ['sadd', 'prox:ut:u1', 'h1'],
      ['pexpire', 'prox:ut:u1', 120_000],
    ]);
  });

  it('MULTI com erro ou abortado lança (o service responde 503, fail-closed)', async () => {
    await expect(
      new RedisProximityStore(fakeRedis([[new Error('OOM'), null]]).redis as never).issue(
        'h1',
        RECORD,
        TTLS,
      ),
    ).rejects.toThrow('OOM');
    await expect(
      new RedisProximityStore(fakeRedis(null).redis as never).issue('h1', RECORD, TTLS),
    ).rejects.toThrow();
  });

  it('[PROX-31] leituras (com o canal; sem canal válido = inexistente), revogação, contador e bloqueio', async () => {
    const { redis } = fakeRedis();
    const store = new RedisProximityStore(redis as never);
    expect(await store.findValid(['h1', 'hq', 'old', 'nfc', 'h9'])).toEqual([
      { userId: 'u1', issuedAt: 7, channel: 'ble' },
      { userId: 'u1', issuedAt: 7, channel: 'qr' },
      null,
      null,
      null,
    ]);
    expect(await store.findValid([])).toEqual([]);
    expect(await store.findRecent('h1')).toBeNull();
    expect(await store.isScreenOpen('u1')).toBe(true);
    await store.revokeUser('u1');
    expect(redis.del).toHaveBeenCalledWith(
      'prox:t:h1',
      'prox:r:h1',
      'prox:t:h2',
      'prox:r:h2',
      'prox:u:u1',
      'prox:ut:u1',
    );
    expect(await store.hit('rl:x', 1_000)).toEqual({ count: 3, resetInMs: 500 });
    await store.lock('u1', 900_000);
    expect(redis.set).toHaveBeenCalledWith('prox:lock:u1', '1', 'PX', 900_000);
    expect(await store.lockRemainingMs('u1')).toBe(0);
  });

  it('[PROX-48] recordTouch roda o script Lua atômico com as duas observações, o horário, a janela e o hash', async () => {
    const { redis } = fakeRedis();
    redis.eval.mockResolvedValueOnce(0 as never).mockResolvedValueOnce(1 as never);
    const store = new RedisProximityStore(redis as never);
    expect(await store.recordTouch('a', 'b', 'hb', 123, WINDOW_MS)).toBe(false);
    expect(await store.recordTouch('b', 'a', 'ha', 124, WINDOW_MS)).toBe(true);
    expect(redis.eval).toHaveBeenNthCalledWith(
      1,
      TOUCH_SCRIPT,
      2,
      'prox:o:a:b',
      'prox:o:b:a',
      '123',
      '5000',
      'hb',
    );
    expect(redis.eval).toHaveBeenNthCalledWith(
      2,
      TOUCH_SCRIPT,
      2,
      'prox:o:b:a',
      'prox:o:a:b',
      '124',
      '5000',
      'ha',
    );
    // A2 rev. 1 (R1-1): todo relato regrava a própria observação com PX 2 × janela (prazo
    // deslizante), mantendo o primeiro relato se ela existe; sem KEEPTTL.
    expect(TOUCH_SCRIPT).toContain(
      "redis.call('SET', KEYS[1], (first or ARGV[1]) .. ':' .. ARGV[3], 'PX', 2 * window)",
    );
    expect(TOUCH_SCRIPT).not.toContain('KEEPTTL');
    expect(TOUCH_SCRIPT.match(/redis\.call\('SET'/g)).toHaveLength(1);
    // A do outro só vale com o primeiro relato a menos que a janela.
    expect(TOUCH_SCRIPT).toContain(
      'if otherFirst and tonumber(ARGV[1]) - tonumber(otherFirst) < window then',
    );
  });

  it('[PROX-54] [PROX-66] claimTouchPair: um script só, com as 10 chaves e os 9 argumentos do A2, na ordem; o cartão nulo vai como "" e volta refused (A3-1); resposta fora das seis → erro (503)', async () => {
    const { redis } = fakeRedis();
    redis.eval
      .mockResolvedValueOnce('created' as never)
      .mockResolvedValueOnce('refused' as never)
      .mockResolvedValueOnce('OK' as never);
    const store = new RedisProximityStore(redis as never);
    const input = {
      callerId: 'b',
      otherId: 'a',
      atMs: 124,
      pairTtlMs: PAIR_MS,
      windowMs: WINDOW_MS,
      busyMs: BUSY_MS,
      perHour: 10,
      perDay: 30,
      callerCard: card('b', 124),
    };
    expect(await store.claimTouchPair(input)).toBe('created');
    expect(redis.eval).toHaveBeenLastCalledWith(
      CLAIM_TOUCH_SCRIPT,
      10,
      'prox:m:a:b',
      'prox:o:a:b',
      'rl:prox-pairs:hour:b',
      'rl:prox-pairs:day:b',
      'rl:prox-pairs:hour:a',
      'rl:prox-pairs:day:a',
      'prox:v:a',
      'prox:v:b',
      'prox:c:a',
      'prox:c:b',
      '124',
      '60000',
      '5000',
      '10',
      '3600000',
      '30',
      '86400000',
      '{"s":"b","at":124,"h":"h.b","n":"Nome b","a":"avatars/b.jpg","c":false}',
      '10000',
    );
    expect(await store.claimTouchPair({ ...input, callerCard: null })).toBe('refused');
    expect(redis.eval).toHaveBeenLastCalledWith(
      CLAIM_TOUCH_SCRIPT,
      10,
      'prox:m:a:b',
      'prox:o:a:b',
      'rl:prox-pairs:hour:b',
      'rl:prox-pairs:day:b',
      'rl:prox-pairs:hour:a',
      'rl:prox-pairs:day:a',
      'prox:v:a',
      'prox:v:b',
      'prox:c:a',
      'prox:c:b',
      '124',
      '60000',
      '5000',
      '10',
      '3600000',
      '30',
      '86400000',
      '',
      '10000',
    );
    await expect(store.claimTouchPair(input)).rejects.toThrow(/casamento/);
    for (const step of [
      "return 'gone'",
      "if ARGV[8] == '' then return 'refused' end",
      "return 'busy'",
      "return 'capped'",
      "redis.call('INCR', KEYS[index + 2])",
      "redis.call('PEXPIRE', KEYS[index + 2], windows[index])",
      "redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])",
      "redis.call('SET', KEYS[7], hash .. '|' .. ARGV[8], 'PX', ARGV[2])",
      "redis.call('SET', KEYS[10], '1', 'PX', ARGV[9])",
    ]) {
      expect(CLAIM_TOUCH_SCRIPT).toContain(step);
    }
    // A3-1: o `refused` vem logo depois do `gone` e antes de qualquer leitura de ocupado, par ou
    // contador (os `EXISTS` e o `GET` dos contadores).
    const refused = CLAIM_TOUCH_SCRIPT.indexOf("return 'refused'");
    expect(refused).toBeGreaterThan(CLAIM_TOUCH_SCRIPT.indexOf("return 'gone'"));
    expect(refused).toBeLessThan(CLAIM_TOUCH_SCRIPT.indexOf("redis.call('EXISTS'"));
    expect(refused).toBeLessThan(CLAIM_TOUCH_SCRIPT.indexOf("redis.call('GET', KEYS[index + 2])"));
    // [PROX-66] Entre o `gone` e o `refused`, nenhum comando: o `refused` não lê nem grava nada
    // (o `real-services` confere no Valkey; aqui, sem ele, pelo texto do script).
    expect(
      CLAIM_TOUCH_SCRIPT.slice(CLAIM_TOUCH_SCRIPT.indexOf("return 'gone'"), refused),
    ).not.toContain('redis.call');
  });

  it('[PROX-67] [PROX-49] takeOwedCard (A3-2): um script só (GET; já marcado → devolve sem gravar; senão, marca "!" com o prazo menor e grava o ocupado; sem DEL); "{hash}|{json}" → redelivered false, "!{hash}|{json}" → redelivered true; nil ou ilegível → null', async () => {
    const { redis } = fakeRedis();
    const json = '{"s":"b","at":124,"h":"h.b","n":"Nome b","a":null,"c":true}';
    redis.eval
      .mockResolvedValueOnce(`hb|${json}` as never)
      .mockResolvedValueOnce(`!hb|${json}` as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce('ilegível' as never)
      .mockResolvedValueOnce('!ilegível' as never)
      .mockResolvedValueOnce('!' as never);
    const store = new RedisProximityStore(redis as never);
    const card = {
      tokenHash: 'hb',
      subjectId: 'b',
      atMs: 124,
      handle: 'h.b',
      name: 'Nome b',
      avatarKey: null,
      connected: true,
    };
    expect(await store.takeOwedCard('a', BUSY_MS)).toEqual({ ...card, redelivered: false });
    expect(redis.eval).toHaveBeenLastCalledWith(
      TAKE_OWED_CARD_SCRIPT,
      2,
      'prox:v:a',
      'prox:c:a',
      '10000',
    );
    expect(await store.takeOwedCard('a', BUSY_MS)).toEqual({ ...card, redelivered: true });
    for (let index = 0; index < 4; index++) {
      expect(await store.takeOwedCard('a', BUSY_MS)).toBeNull();
    }
    expect(TAKE_OWED_CARD_SCRIPT).not.toContain("'DEL'");
    for (const step of [
      'if not card then return false end',
      "if string.sub(card, 1, 1) == '!' then return card end",
      'local keep = tonumber(ARGV[1])',
      "local ttl = redis.call('PTTL', KEYS[1])",
      'if ttl > 0 and ttl < keep then keep = ttl end',
      "redis.call('SET', KEYS[1], '!' .. card, 'PX', keep)",
      "redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])",
    ]) {
      expect(TAKE_OWED_CARD_SCRIPT).toContain(step);
    }
    // A reentrega sai antes de qualquer gravação: não mexe em prazo nem em ocupado.
    expect(TAKE_OWED_CARD_SCRIPT.indexOf("== '!' then return card end")).toBeLessThan(
      TAKE_OWED_CARD_SCRIPT.indexOf("redis.call('SET'"),
    );
  });

  it('[PROX-42] forgetTouchState (só dev): DEL do cartão devido e da marca de ocupado', async () => {
    const { redis } = fakeRedis();
    await new RedisProximityStore(redis as never).forgetTouchState('p');
    expect(redis.del).toHaveBeenLastCalledWith('prox:v:p', 'prox:c:p');
  });

  it('[PROX-63] [PROX-56] countBlockSignal: um script só, com o par, os dois contadores, o sentido e a janela; nil → null; {blocker, blocked}; resposta fora do formato → erro', async () => {
    const { redis } = fakeRedis();
    const low = '01a189e0-af57-7000-85fe-2054e618fe0a';
    const high = '01a189e0-af57-7000-85fe-2054e618fe0b';
    redis.eval
      .mockResolvedValueOnce([1, 3] as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce('OK' as never)
      .mockResolvedValueOnce([1] as never);
    const store = new RedisProximityStore(redis as never);
    expect(await store.countBlockSignal(high, low, 604_800_000)).toEqual({
      blocker: 1,
      blocked: 3,
    });
    expect(redis.eval).toHaveBeenLastCalledWith(
      BLOCK_SIGNAL_SCRIPT,
      3,
      `prox:m:${low}:${high}`,
      `rl:prox-block-after-touch:blocker:${high}`,
      `rl:prox-block-after-touch:blocked:${low}`,
      'b',
      '604800000',
    );
    expect(await store.countBlockSignal(low, high, 604_800_000)).toBeNull();
    expect(redis.eval).toHaveBeenLastCalledWith(
      BLOCK_SIGNAL_SCRIPT,
      3,
      `prox:m:${low}:${high}`,
      `rl:prox-block-after-touch:blocker:${low}`,
      `rl:prox-block-after-touch:blocked:${high}`,
      'a',
      '604800000',
    );
    await expect(store.countBlockSignal(low, high, 1)).rejects.toThrow(/sinal de bloqueio/);
    await expect(store.countBlockSignal(low, high, 1)).rejects.toThrow(/sinal de bloqueio/);
    for (const step of [
      "local at, marks = string.match(pair, '^(%d+):?([ab]*)$')",
      'if not at or string.find(marks, ARGV[1], 1, true) then return false end',
      "redis.call('SET', KEYS[1], at .. ':' .. marks .. ARGV[1], 'KEEPTTL')",
      "redis.call('INCR', KEYS[index])",
      "redis.call('PEXPIRE', KEYS[index], ARGV[2])",
    ]) {
      expect(BLOCK_SIGNAL_SCRIPT).toContain(step);
    }
  });

  it('[PROX-32] par encostado: SET PX 60 s na chave ordenada e EXISTS na mesma chave', async () => {
    const { redis } = fakeRedis();
    const store = new RedisProximityStore(redis as never);
    await store.markTouchPair('b', 'a', PAIR_MS, 99);
    expect(redis.set).toHaveBeenCalledWith('prox:m:a:b', '99', 'PX', PAIR_MS);
    expect(await store.hasTouchPair('a', 'b')).toBe(true);
    expect(redis.exists).toHaveBeenLastCalledWith('prox:m:a:b');
    redis.exists.mockResolvedValueOnce(0);
    expect(await store.hasTouchPair('b', 'a')).toBe(false);
  });
});
