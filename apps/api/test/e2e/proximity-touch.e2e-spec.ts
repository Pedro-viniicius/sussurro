// E2E do Adendo A2 da ADR 0012 (teto de pessoas novas, revelação simétrica garantida e uma pessoa
// por vez), da revisão 1 (prazo deslizante, cartão devido antes das recusas, `pairExpiresInS`) e
// do sinal de abuso (A2-3): testes.md PROX-45, 46, 48 a 55, 60 e 64. Bloquear e denunciar pelo
// cartão e o sinal por sentido (PROX-61 a 63) ficam em `proximity-card-actions.e2e-spec.ts`. Tudo
// pelas rotas de verdade (touches, bloqueio, logout, exclusão de conta, pedido `ble`), com a
// política em SQL e o fake do Redis sobre o relógio de teste (sem `sleep`). O `TestProximityStore`
// registra o resultado de cada casamento (`claims`): a resposta HTTP é a mesma para teto, ocupado e
// não mútuo (PROX-46), então o teste confere também **por que** o encosto não confirmou.
//
// Ficam só no unitário (`proximity.service.spec.ts` e `proximity.store.spec.ts`), por não terem
// caminho pela rota: o `gone` entre o relato e o casamento (a observação vencendo durante a consulta
// ao banco), o Valkey lento (> 500 ms) no sinal de abuso, a conta excluída antes do e-mail do sinal
// e o valor de `prox:o` no formato antigo (também no Valkey, `real-services`, PROX-56).
import { blocks, connectionRequests, eq, users } from '@sussurro/db';
import { block, connect, TEST_PASSWORD } from '@sussurro/db/testing';
import { ErrorResponseSchema, type ProximityToken } from '@sussurro/shared';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashProximityToken } from '../../src/modules/proximity/proximity-token.js';
import { PROXIMITY_TOUCH_CAPPED } from '../../src/modules/proximity/proximity.service.js';
import {
  proximityKeys,
  TOUCH_PAIRS_DAY_MS,
  TOUCH_PAIRS_HOUR_MS,
} from '../../src/modules/proximity/proximity.store.js';
import { bearer, loginViaApi } from '../support/auth.js';
import {
  issueTokens,
  type Person,
  person,
  renewSession,
  reportTouch,
  requestConnection,
  touch,
  touchItems,
  UNKNOWN_TOKEN,
} from '../support/proximity.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;
/** Linhas do log de produção (pino), nível `warn`: o log do teto não pode trazer id nem token. */
const logLines: string[] = [];

beforeAll(async () => {
  t = await createTestApp({
    env: { LOG_LEVEL: 'warn' },
    logStream: {
      write: (line: string) => {
        logLines.push(line);
      },
    },
  });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  logLines.length = 0;
});

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** Janela do casamento (`PROX_TOUCH_WINDOW_S`, 5 s, contada do primeiro relato do outro). */
const WINDOW_MS = 5 * SECOND;
/** Ocupado (A2-2): quem recebe um cartão não casa com ninguém por 10 s. */
const BUSY_MS = 10 * SECOND;
const UNAVAILABLE = {
  code: 'PROXIMITY_UNAVAILABLE',
  message: 'Conectar está indisponível agora. Tente de novo em instantes.',
};
/** Entre dois encostos da mesma conta: o ocupado e uma folga (o limite é de 6 emissões por minuto). */
const BETWEEN_TOUCHES_MS = 12 * SECOND;
const PAIR_MS = 60 * SECOND;

interface Encounter {
  firstTokens: ProximityToken;
  secondTokens: ProximityToken;
  /** O primeiro relato de `first` (nunca casa). */
  opening: Response;
  /** O relato de `second`: se casar, cria o par e traz o cartão de `first`. */
  answer: Response;
  /** O relato seguinte de `first`: o cartão devido, se houver. */
  delivery: Response;
}

/**
 * Um encosto como os dois aparelhos fazem (A2-2): os dois abrem a tela com tokens novos; `first`
 * relata o `bleToken` de `second` (sem cartão); `second` relata o de `first` (se casar, cria o par e
 * recebe o cartão de `first`); `first` relata de novo (recebe o cartão devido, se houver). Não
 * avança o relógio; quem encadeia encostos da mesma conta chama `rest()`.
 */
async function encounter(first: Person, second: Person): Promise<Encounter> {
  const firstTokens = await issueTokens(t, first);
  const secondTokens = await issueTokens(t, second);
  const opening = await reportTouch(t, first, [secondTokens.bleToken]).expect(200);
  const answer = await reportTouch(t, second, [firstTokens.bleToken]).expect(200);
  const delivery = await reportTouch(t, first, [secondTokens.bleToken]).expect(200);
  return { firstTokens, secondTokens, opening, answer, delivery };
}

function rest(ms = BETWEEN_TOUCHES_MS): void {
  t.clock.advance(ms);
}

/** A resposta de não mútuo (token inexistente) de uma conta sem cartão a receber. */
async function notMutual(): Promise<Response> {
  const bystander = await person(t);
  await issueTokens(t, bystander);
  return reportTouch(t, bystander, [UNKNOWN_TOKEN]).expect(200);
}

/** A mesma resposta, byte a byte: status, corpo e os cabeçalhos da rota. */
function expectSameAs(response: Response, reference: Response, label: string): void {
  const shape = (r: Response) => ({
    status: r.status,
    text: r.text,
    cacheControl: r.headers['cache-control'] as unknown,
    contentType: r.headers['content-type'] as unknown,
  });
  expect({ label, ...shape(response) }).toEqual({ label, ...shape(reference) });
}

/**
 * Os contadores do teto da conta. O fake só tem a leitura que soma (`hit`), então esta leitura soma
 * 1 em cada um: use só quando a conta não vai mais casar no teste.
 */
async function pairCountersOnce(who: Person): Promise<{ hour: number; day: number }> {
  const hour = await t.proximity.hit(proximityKeys.pairsPerHour(who.user.id), TOUCH_PAIRS_HOUR_MS);
  const day = await t.proximity.hit(proximityKeys.pairsPerDay(who.user.id), TOUCH_PAIRS_DAY_MS);
  return { hour: hour.count - 1, day: day.count - 1 };
}

/** Cartões devidos vivos (`prox:v:*`). */
function owedKeys(): string[] {
  return t.proximity
    .entries()
    .map((entry) => entry.key)
    .filter((key) => key.startsWith('prox:v:'));
}

function hasPair(first: Person, second: Person): Promise<boolean> {
  return t.proximity.hasTouchPair(first.user.id, second.user.id);
}

/** Agora no relógio de teste (ms). */
function now(): number {
  return t.clock.now().getTime();
}

/** O valor vivo de uma chave do fake (`undefined` se não existe ou venceu). */
function valueOf(key: string): string | undefined {
  return t.proximity.entries().find((entry) => entry.key === key)?.value;
}

describe('teto de pessoas novas (ADR 0012, A2-1)', () => {
  it('[PROX-45] [PROX-46] com os padrões do PO (10/h, 30/dia), nos dois lados: o 11º par novo da hora não confirma para ninguém (byte a byte igual a não mútuo), sem par, sem cartão devido, sem somar, sem falha e sem 429; renovar não conta; a hora seguinte libera; o 31º do dia continua barrado; o dia seguinte libera; o log sai sem ids nem tokens', async () => {
    const ana = await person(t, 'ana.teto');
    const reference = await notMutual();
    const tokensSeen: string[] = [];
    const remember = (seen: Encounter) => {
      for (const tokens of [seen.firstTokens, seen.secondTokens]) {
        tokensSeen.push(tokens.bleToken, tokens.qrToken);
      }
      return seen;
    };
    /** Um par novo de Ana, que se alterna entre criar o par e ser vista (os dois lados contam). */
    const newPair = async (index: number) => {
      const other = await person(t);
      const seen = remember(
        index % 2 === 0 ? await encounter(other, ana) : await encounter(ana, other),
      );
      expect(touchItems(seen.answer), `par ${String(index)}`).toHaveLength(1);
      expect(touchItems(seen.delivery), `par ${String(index)}`).toHaveLength(1);
      rest();
      return other;
    };

    // 1ª hora: 10 pares novos; renovar o 1º (par vivo) no meio não conta.
    const firstOther = await newPair(1);
    const renewal = remember(await encounter(firstOther, ana));
    expect(touchItems(renewal.answer)).toHaveLength(1);
    rest();
    for (let index = 2; index <= 10; index++) {
      await newPair(index);
    }
    expect(t.proximity.claims).toEqual([
      'created',
      'renewed',
      ...Array.from({ length: 9 }, () => 'created'),
    ]);

    // O 11º par novo da hora: Ana no teto barra o par quando chama e quando é vista.
    const late = await person(t, 'late.teto');
    const anaCalls = remember(await encounter(late, ana));
    rest();
    const later = await person(t, 'later.teto');
    const anaIsSeen = remember(await encounter(ana, later));
    rest();
    for (const [label, seen] of [
      ['Ana chama', anaCalls],
      ['Ana é vista', anaIsSeen],
    ] as const) {
      expectSameAs(seen.opening, reference, `${label}: o primeiro relato`);
      expectSameAs(seen.answer, reference, `${label}: quem casaria`);
      expectSameAs(seen.delivery, reference, `${label}: o relato seguinte do outro`);
    }
    // Em cada encosto barrado, os dois lados tentam casar (o relato de quem casaria e o relato
    // seguinte do outro): 4 tentativas, todas no teto.
    expect(t.proximity.claims.slice(-4)).toEqual(['capped', 'capped', 'capped', 'capped']);
    expect(await hasPair(ana, late)).toBe(false);
    expect(await hasPair(ana, later)).toBe(false);
    expect(owedKeys()).toEqual([]);
    // Não conta como falha de token (20 bloqueariam a proximidade).
    expect(await t.proximity.lockRemainingMs(ana.user.id)).toBe(0);
    // Quem casaria com Ana não somou nada (eles não casam mais neste teste).
    expect(await pairCountersOnce(late)).toEqual({ hour: 0, day: 0 });
    expect(await pairCountersOnce(later)).toEqual({ hour: 0, day: 0 });

    // O log do teto: uma linha por tentativa barrada, sem ids, @ ou tokens.
    const cappedLines = logLines.filter((line) => line.includes(PROXIMITY_TOUCH_CAPPED));
    expect(cappedLines).toHaveLength(4);
    for (const line of cappedLines) {
      for (const secret of [
        ana.user.id,
        late.user.id,
        later.user.id,
        ana.user.handle,
        late.user.handle,
        later.user.handle,
        ...tokensSeen,
      ]) {
        expect(line).not.toContain(secret);
      }
    }

    // A hora seguinte libera (a janela fixa começou no 1º par novo de Ana): mais 10 na 2ª hora e
    // 10 na 3ª. Se as tentativas barradas tivessem somado no dia de Ana, o 27º já não casaria.
    for (const hour of [2, 3]) {
      t.clock.advance(TOUCH_PAIRS_HOUR_MS);
      await renewSession(t, ana);
      for (let index = (hour - 1) * 10 + 1; index <= hour * 10; index++) {
        await newPair(index);
      }
    }

    // 4ª hora: o teto da hora liberou, mas o do dia (30) não.
    t.clock.advance(TOUCH_PAIRS_HOUR_MS);
    await renewSession(t, ana);
    const dayCapped = await encounter(await person(t), ana);
    expectSameAs(dayCapped.answer, reference, 'teto do dia');
    expectSameAs(dayCapped.delivery, reference, 'teto do dia: o outro');
    expect(t.proximity.claims.at(-1)).toBe('capped');
    rest();

    // O dia seguinte libera.
    t.clock.advance(TOUCH_PAIRS_DAY_MS);
    await renewSession(t, ana);
    await newPair(31);
    expect(t.proximity.claims.at(-1)).toBe('created');
  });

  it('[PROX-46] a política vem antes do teto: par recusado por bloqueio (nos dois sentidos) ou conta excluída nunca chega ao casamento nem toca os contadores; a resposta é a de não mútuo, byte a byte, para os dois lados', async () => {
    const ana = await person(t, 'ana.politica');
    const blockedByAna = await person(t);
    const blockedAna = await person(t);
    const deleted = await person(t);
    await block(t.database.db, ana.user, blockedByAna.user);
    await block(t.database.db, blockedAna.user, ana.user);
    const reference = await notMutual();

    for (const other of [blockedByAna, blockedAna]) {
      for (const seen of [await encounter(other, ana), await encounter(ana, other)]) {
        expectSameAs(seen.answer, reference, 'quem casaria');
        expectSameAs(seen.delivery, reference, 'o outro');
      }
    }
    // Conta excluída depois do primeiro relato dela (os tokens continuam no Redis; quem barra é a
    // política).
    const deletedTokens = await issueTokens(t, deleted);
    const anaTokens = await issueTokens(t, ana);
    await reportTouch(t, deleted, [anaTokens.bleToken]).expect(200);
    await t.database.db
      .update(users)
      .set({ deletedAt: t.clock.now() })
      .where(eq(users.id, deleted.user.id));
    expectSameAs(
      await reportTouch(t, ana, [deletedTokens.bleToken]).expect(200),
      reference,
      'conta excluída',
    );

    expect(t.proximity.claims).toEqual([]);
    expect(t.proximity.entries().filter((entry) => /^prox:[mvc]:/.test(entry.key))).toEqual([]);
    expect(await pairCountersOnce(ana)).toEqual({ hour: 0, day: 0 });
    expect(await pairCountersOnce(blockedAna)).toEqual({ hour: 0, day: 0 });
  });
});

describe('janela do primeiro relato, com prazo deslizante (ADR 0012, A2-2 §1; A2 rev. 1, R1-1)', () => {
  it('[PROX-48] relatos a 1/s por 30 s (o token do outro rodando aos 20 s): cada relato regrava prox:o mantendo o primeiroMs e trocando o hash; o outro não casa depois dos 5 s; a chave vive 10 s desde o último relato, não desde o primeiro', async () => {
    const v = await person(t, 'vitoria');
    const b = await person(t, 'bruno.b');
    let vTokens = await issueTokens(t, v);
    let bTokens = await issueTokens(t, b);
    const start = now();
    const key = proximityKeys.touch(v.user.id, b.user.id);

    for (let second = 0; second < 30; second++) {
      if (second === 20) {
        // Os dois apps rodam os tokens a cada 20 s; o dono continua o mesmo, então a chave também.
        vTokens = await issueTokens(t, v);
        bTokens = await issueTokens(t, b);
      }
      const label = `${String(second)} s`;
      expect((await reportTouch(t, v, [bTokens.bleToken]).expect(200)).body, label).toEqual({
        items: [],
      });
      // Só o hash muda; o horário continua o do primeiro relato (com o KEEPTTL antigo, a chave
      // sumia aos 10 s e o relato seguinte a recriava com outro horário).
      expect(valueOf(key), label).toBe(`${String(start)}:${hashProximityToken(bTokens.bleToken)}`);
      t.clock.advance(SECOND);
    }

    // 30 s: B relata V. O primeiro relato de V tem 30 s, fora da janela: não casa.
    expect((await reportTouch(t, b, [vTokens.bleToken]).expect(200)).body).toEqual({ items: [] });
    expect(t.proximity.claims).toEqual([]);

    // O último relato de V foi aos 29 s: a chave vive até os 39 s.
    t.clock.advance(start + 39 * SECOND - 1 - now());
    expect(valueOf(key)).toBe(`${String(start)}:${hashProximityToken(bTokens.bleToken)}`);
    t.clock.advance(1);
    expect(valueOf(key)).toBeUndefined();
  });

  it('[PROX-48] 9,999 s sem relato: a chave vive e o relato seguinte mantém o primeiroMs; 10 s sem relato: a chave some e o relato seguinte abre outra janela, em que o outro casa com 4,999 s', async () => {
    const v = await person(t, 'vitoria');
    const b = await person(t, 'bruno.b');
    const vTokens = await issueTokens(t, v);
    const bTokens = await issueTokens(t, b);
    const key = proximityKeys.touch(v.user.id, b.user.id);
    const hash = hashProximityToken(bTokens.bleToken);
    const start = now();

    await reportTouch(t, v, [bTokens.bleToken]).expect(200);
    t.clock.advance(2 * WINDOW_MS - 1);
    expect(valueOf(key)).toBe(`${String(start)}:${hash}`);
    await reportTouch(t, v, [bTokens.bleToken]).expect(200);
    expect(valueOf(key)).toBe(`${String(start)}:${hash}`);

    // Exatamente 10 s sem relato: a chave some; o relato seguinte abre outra janela.
    t.clock.advance(2 * WINDOW_MS);
    expect(valueOf(key)).toBeUndefined();
    const reopened = now();
    await reportTouch(t, v, [bTokens.bleToken]).expect(200);
    expect(valueOf(key)).toBe(`${String(reopened)}:${hash}`);

    t.clock.advance(WINDOW_MS - 1);
    expect(touchItems(await reportTouch(t, b, [vTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: vTokens.bleToken, handle: 'vitoria' }),
    ]);
    expect(t.proximity.claims).toEqual(['created']);
  });

  it('[PROX-48] atraso honesto: V relata de 0 a 5 s, B só aos 6 s (não casa), o relato de V aos 7 s casa (V cria o par) e B recebe o cartão de V no relato seguinte', async () => {
    const v = await person(t, 'vitoria');
    const b = await person(t, 'bruno.b');
    const vTokens = await issueTokens(t, v);
    const bTokens = await issueTokens(t, b);
    const start = now();
    const key = proximityKeys.touch(v.user.id, b.user.id);

    for (let second = 0; second < 6; second++) {
      expect((await reportTouch(t, v, [bTokens.bleToken]).expect(200)).body).toEqual({
        items: [],
      });
      expect(valueOf(key)).toBe(`${String(start)}:${hashProximityToken(bTokens.bleToken)}`);
      t.clock.advance(SECOND);
    }
    // 6 s: B percebe o encosto atrasado; o primeiro relato de V tem 6 s, fora da janela.
    expect((await reportTouch(t, b, [vTokens.bleToken]).expect(200)).body).toEqual({ items: [] });
    expect(t.proximity.claims).toEqual([]);

    // 7 s: o relato de V casa com a observação nova de B (aberta aos 6 s).
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, v, [bTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: bTokens.bleToken, handle: 'bruno.b' }),
    ]);
    expect(t.proximity.claims).toEqual(['created']);
    // B recebe o cartão de V no relato seguinte: a revelação continua simétrica.
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, b, [vTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: vTokens.bleToken, handle: 'vitoria' }),
    ]);
  });
});

describe('atacante sem janela (ADR 0012, A2 rev. 1, R1-2)', () => {
  /**
   * V relata M a cada 1 s, de 0 a `lastS` (o app), com tM2 (outro token de M, um "encostado" novo
   * aos 3 s) de 3 a 8 s e tM no resto. O relógio fica no último relato.
   */
  async function vReportsM(v: Person, m: Person, lastS: number) {
    const vTokens = await issueTokens(t, v);
    const tM = (await issueTokens(t, m)).bleToken;
    let tM2 = '';
    for (let second = 0; second <= lastS; second++) {
      if (second === 3) {
        tM2 = (await issueTokens(t, m)).bleToken;
      }
      const token = second >= 3 && second <= 8 ? tM2 : tM;
      expect(
        (await reportTouch(t, v, [token]).expect(200)).body,
        `V aos ${String(second)} s`,
      ).toEqual({ items: [] });
      if (second < lastS) {
        t.clock.advance(SECOND);
      }
    }
    return { vTokens, tM };
  }

  it('[PROX-52] variante A: V relata tM a cada 1 s de 0 a 12 s, com tM2 no meio; M relata tV só depois do último relato de V, aos 13, 15 e 21,9 s → nunca casa, sem par e sem cartão devido (com o KEEPTTL antigo, o de 13 s casaria)', async () => {
    const v = await person(t);
    const m = await person(t);
    const start = now();
    const { vTokens, tM } = await vReportsM(v, m, 12);

    for (const atMs of [13_000, 15_000, 21_900]) {
      t.clock.advance(start + atMs - now());
      expect(
        (await reportTouch(t, m, [vTokens.bleToken]).expect(200)).body,
        `M aos ${String(atMs)} ms`,
      ).toEqual({ items: [] });
    }
    expect(t.proximity.claims).toEqual([]);
    expect(await hasPair(v, m)).toBe(false);
    expect(owedKeys()).toEqual([]);
    // A chave de V sobre M ainda vive aos 21,9 s (10 s desde o último relato, aos 12 s), com o
    // primeiroMs de 0 s: a janela de 5 s, contada dele, ficou fechada o tempo todo.
    expect(valueOf(proximityKeys.touch(v.user.id, m.user.id))).toBe(
      `${String(start)}:${hashProximityToken(tM)}`,
    );
  });

  it('[PROX-52] variante A, à parte: com M relatando enquanto V ainda relata (aos 9,9 s), o relato de V aos 10 s casa pelo atraso honesto: V vê M na hora e M recebe o cartão de V no relato seguinte (revelação simétrica, não ataque)', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const start = now();
    const { vTokens, tM } = await vReportsM(v, m, 9);

    t.clock.advance(start + 9_900 - now());
    expect((await reportTouch(t, m, [vTokens.bleToken]).expect(200)).body).toEqual({ items: [] });
    expect(t.proximity.claims).toEqual([]);

    t.clock.advance(start + 10 * SECOND - now());
    expect(touchItems(await reportTouch(t, v, [tM]).expect(200))).toEqual([
      expect.objectContaining({ token: tM, handle: 'mauro', pairExpiresInS: 55 }),
    ]);
    expect(t.proximity.claims).toEqual(['created']);
    t.clock.advance(900);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: vTokens.bleToken, handle: 'vera', pairExpiresInS: 55 }),
    ]);
    expect(t.proximity.claims).toEqual(['created']);
  });

  it('[PROX-52] variante B: V relata tM em 0, tX de 1 a 8 s, tY de 9 a 14 s e tM de novo aos 15 s → a chave de V sobre M some aos 10 s e volta aos 15 (janela de 15 a 20); M relata aos 16 s → created, e o relato de V aos 17 s recebe o cartão de M', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const x = await person(t);
    const y = await person(t);
    const vTokens = await issueTokens(t, v);
    const tM = (await issueTokens(t, m)).bleToken;
    const tX = (await issueTokens(t, x)).bleToken;
    const tY = (await issueTokens(t, y)).bleToken;
    const key = proximityKeys.touch(v.user.id, m.user.id);
    const start = now();

    for (let second = 0; second <= 15; second++) {
      if (second === 10) {
        // 10 s sem relato de V sobre M: a chave sumiu (com 9,999 s ainda vivia).
        t.clock.advance(start + 10 * SECOND - 1 - now());
        expect(valueOf(key)).toBe(`${String(start)}:${hashProximityToken(tM)}`);
      }
      t.clock.advance(start + second * SECOND - now());
      if (second === 10) {
        expect(valueOf(key)).toBeUndefined();
      }
      const token = second === 0 || second === 15 ? tM : second <= 8 ? tX : tY;
      expect(
        (await reportTouch(t, v, [token]).expect(200)).body,
        `V aos ${String(second)} s`,
      ).toEqual({ items: [] });
    }
    // 15 s: o relato de tM abre outra janela (de 15 a 20 s).
    expect(valueOf(key)).toBe(`${String(start + 15 * SECOND)}:${hashProximityToken(tM)}`);

    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: vTokens.bleToken, handle: 'vera', pairExpiresInS: 55 }),
    ]);
    expect(t.proximity.claims).toEqual(['created']);
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, v, [tM]).expect(200))).toEqual([
      expect.objectContaining({ token: tM, handle: 'mauro', pairExpiresInS: 55 }),
    ]);
  });
});

describe('revelação simétrica garantida (ADR 0012, A2-2)', () => {
  it('[PROX-49] M casa, recebe o cartão de V e bloqueia V pela rota: o relato seguinte de V recebe o cartão de M (@, nome, foto e alreadyConnected do casamento, pairExpiresInS) com o token relatado; o pedido ble de V para M → 400 genérico, nada gravado; o relato depois desse → [] (entrega única); entre desconhecidos, pela rota com o par vivo (PROX-61), o mesmo', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    // Eram conexões: o bloqueio pelo @ é gravado (desfaz a conexão).
    await connect(t.database.db, v.user, m.user);
    const avatarKey = `avatars/${m.user.id}/foto.jpg`;
    await t.database.db.update(users).set({ avatarKey }).where(eq(users.id, m.user.id));
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);

    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ handle: 'vera', alreadyConnected: true }),
    ]);
    await t.http.post('/v1/me/blocks').set(m.headers).send({ handle: 'vera' }).expect(204);
    expect(await t.database.db.select().from(blocks)).toHaveLength(1);

    t.clock.advance(SECOND);
    const delivered = await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    expect(touchItems(delivered)).toEqual([
      {
        token: mTokens.bleToken,
        handle: 'mauro',
        name: m.user.name,
        avatarUrl: expect.stringContaining(avatarKey) as unknown,
        alreadyConnected: true,
        // Casamento há 1 s: o mesmo degrau do cartão na hora (PROX-64).
        pairExpiresInS: 55,
      },
    ]);
    // O bloqueio vale para o pedido: 400 genérico, nenhum pedido gravado.
    const refused = await requestConnection(t, v, mTokens.bleToken, 'ble').expect(400);
    expect(ErrorResponseSchema.parse(refused.body).code).toBe('PROXIMITY_TOKEN_INVALID');
    expect(await t.database.db.select().from(connectionRequests)).toEqual([]);
    // Entrega única.
    t.clock.advance(SECOND);
    expect((await reportTouch(t, v, [mTokens.bleToken]).expect(200)).body).toEqual({ items: [] });
    expect(owedKeys()).toEqual([]);

    // Entre desconhecidos (A2 rev. 1): o atacante bloqueia pela rota, com o par vivo (PROX-61), e
    // o bloqueio é gravado; a vítima recebe o cartão dele do mesmo jeito.
    const stranger = await person(t, 'estranha');
    const attacker = await person(t, 'atacante');
    const strangerTokens = await issueTokens(t, stranger);
    const attackerTokens = await issueTokens(t, attacker);
    await reportTouch(t, stranger, [attackerTokens.bleToken]).expect(200);
    expect(
      touchItems(await reportTouch(t, attacker, [strangerTokens.bleToken]).expect(200)),
    ).toHaveLength(1);
    await t.http
      .post('/v1/me/blocks')
      .set(attacker.headers)
      .send({ handle: 'estranha' })
      .expect(204);
    expect(
      (await t.database.db.select().from(blocks)).filter(
        (row) => row.blockerId === attacker.user.id && row.blockedId === stranger.user.id,
      ),
    ).toHaveLength(1);
    expect(
      touchItems(await reportTouch(t, stranger, [attackerTokens.bleToken]).expect(200)),
    ).toEqual([
      {
        token: attackerTokens.bleToken,
        handle: 'atacante',
        name: attacker.user.name,
        avatarUrl: null,
        alreadyConnected: false,
        pairExpiresInS: 55,
      },
    ]);
    await requestConnection(t, stranger, attackerTokens.bleToken, 'ble').expect(400);
  });

  it('[PROX-50] M casa e sai (logout revoga os tokens): V relata o token revogado e recebe o cartão de M; M casa, muda o nome e exclui a conta: V recebe o cartão do casamento (não lido do banco); o pedido com eles → 400; sem relato em 60 s, o cartão some', async () => {
    // Logout.
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);
    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toHaveLength(1);
    await t.http.post('/v1/auth/logout').set(m.headers).expect(204);
    expect(await t.proximity.findRecent(hashProximityToken(mTokens.bleToken))).toBeNull();
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: mTokens.bleToken, handle: 'mauro', name: m.user.name }),
    ]);
    await requestConnection(t, v, mTokens.bleToken, 'ble').expect(400);

    // Exclusão de conta, com o nome trocado depois do casamento.
    const w = await person(t, 'wanda');
    const n = await person(t, 'nina');
    const wTokens = await issueTokens(t, w);
    const nTokens = await issueTokens(t, n);
    await reportTouch(t, w, [nTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, n, [wTokens.bleToken]).expect(200))).toHaveLength(1);
    await t.database.db.update(users).set({ name: 'Outro Nome' }).where(eq(users.id, n.user.id));
    const session = await loginViaApi(t.http, n.user.email);
    await t.http
      .delete('/v1/me')
      .set(bearer(session.tokens.accessToken))
      .send({ password: TEST_PASSWORD })
      .expect(204);
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, w, [nTokens.bleToken]).expect(200))).toEqual([
      {
        token: nTokens.bleToken,
        handle: 'nina',
        name: n.user.name,
        avatarUrl: null,
        alreadyConnected: false,
        pairExpiresInS: 55,
      },
    ]);
    await requestConnection(t, w, nTokens.bleToken, 'ble').expect(400);
    expect(await t.database.db.select().from(connectionRequests)).toEqual([]);

    // Sem relato por 60 s: o cartão devido some sozinho.
    const x = await person(t);
    const y = await person(t);
    const xTokens = await issueTokens(t, x);
    const yTokens = await issueTokens(t, y);
    await reportTouch(t, x, [yTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, y, [xTokens.bleToken]).expect(200))).toHaveLength(1);
    t.clock.advance(PAIR_MS - 1);
    expect(owedKeys()).toEqual([proximityKeys.owed(x.user.id)]);
    t.clock.advance(1);
    await issueTokens(t, x);
    expect((await reportTouch(t, x, [UNKNOWN_TOKEN]).expect(200)).body).toEqual({ items: [] });
    expect(owedKeys()).toEqual([]);
  });

  it('[PROX-51] [PROX-52] rótulo do cartão devido: V tem par vivo com P; M casa com V e passa a anunciar o token de P; V relata o token de P e recebe o cartão de M com um token nunca emitido, e o pedido com ele dá o 400 genérico sem chegar a P (com o token de P, chegaria); token rodado do dono → o próprio token, e o pedido vale; inexistente → nunca emitido', async () => {
    const v = await person(t, 'vera');
    const p = await person(t, 'paula');
    const m = await person(t, 'mauro');
    await touch(t, v, p);
    rest(BUSY_MS);
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);
    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toHaveLength(1);

    const pTokens = await issueTokens(t, p);
    const [card] = touchItems(await reportTouch(t, v, [pTokens.bleToken]).expect(200));
    expect(card).toMatchObject({ handle: 'mauro', name: m.user.name });
    expect(card!.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect([pTokens.bleToken, mTokens.bleToken, UNKNOWN_TOKEN]).not.toContain(card!.token);
    expect(await t.proximity.findRecent(hashProximityToken(card!.token))).toBeNull();
    const refused = await requestConnection(t, v, card!.token, 'ble').expect(400);
    expect(ErrorResponseSchema.parse(refused.body).code).toBe('PROXIMITY_TOKEN_INVALID');
    expect(await t.database.db.select().from(connectionRequests)).toEqual([]);
    // Controle: o par V–P vale, e com o token de P o pedido chegaria a P. É isso que o rótulo evita.
    await requestConnection(t, v, pTokens.bleToken, 'ble').expect(201);

    // O dono rodou o token (a cada 20 s): o token novo é dele, então é o rótulo, e o pedido vale.
    const a = await person(t, 'alice');
    const b = await person(t);
    const aTokens = await issueTokens(t, a);
    const bTokens = await issueTokens(t, b);
    await reportTouch(t, b, [aTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, a, [bTokens.bleToken]).expect(200))).toHaveLength(1);
    const rotated = await issueTokens(t, a);
    expect(touchItems(await reportTouch(t, b, [rotated.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: rotated.bleToken, handle: 'alice' }),
    ]);
    await requestConnection(t, b, rotated.bleToken, 'ble').expect(201);

    // Token inexistente: o cartão sai com um token que nunca existiu.
    const c = await person(t);
    const d = await person(t, 'duda');
    const cTokens = await issueTokens(t, c);
    const dTokens = await issueTokens(t, d);
    await reportTouch(t, c, [dTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, d, [cTokens.bleToken]).expect(200))).toHaveLength(1);
    const [unknownCard] = touchItems(await reportTouch(t, c, [UNKNOWN_TOKEN]).expect(200));
    expect(unknownCard).toMatchObject({ handle: 'duda' });
    expect([UNKNOWN_TOKEN, dTokens.bleToken]).not.toContain(unknownCard!.token);
    expect(await t.proximity.findRecent(hashProximityToken(unknownCard!.token))).toBeNull();
  });
});

describe('uma pessoa por vez e Redis (ADR 0012, A2-2)', () => {
  it('[PROX-53] [PROX-46] com um cartão a receber, ninguém casa com V (quem tenta recebe a resposta de não mútuo, byte a byte); V recebe o cartão de M, nunca o de X; até 10 s depois, V não casa nos dois sentidos; quem cria o par também fica 10 s ocupado; depois, casa', async () => {
    const reference = await notMutual();
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const x = await person(t, 'xavier');
    const y = await person(t);
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);
    const xTokens = await issueTokens(t, x);
    const yTokens = await issueTokens(t, y);

    // V já tinha percebido X; depois encosta em M, que casa (V fica com o cartão de M a receber).
    await reportTouch(t, v, [xTokens.bleToken]).expect(200);
    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toHaveLength(1);
    const owedToV = t.proximity.entries().find((e) => e.key === proximityKeys.owed(v.user.id));
    // X relata V com a observação de V na janela: ocupado.
    expectSameAs(
      await reportTouch(t, x, [vTokens.bleToken]).expect(200),
      reference,
      'X com V a receber',
    );
    expect(t.proximity.entries().find((e) => e.key === proximityKeys.owed(v.user.id))).toEqual(
      owedToV,
    );

    // V relata X: recebe o cartão devido de M (nunca o de X), com um token que não é o de X.
    t.clock.advance(SECOND);
    const [card] = touchItems(await reportTouch(t, v, [xTokens.bleToken]).expect(200));
    expect(card).toMatchObject({ handle: 'mauro' });
    expect(card!.token).not.toBe(xTokens.bleToken);

    // V recebeu um cartão: ocupada por 10 s, quando X chama e quando V chama.
    t.clock.advance(SECOND);
    expectSameAs(await reportTouch(t, x, [vTokens.bleToken]).expect(200), reference, 'X chama');
    expectSameAs(await reportTouch(t, v, [xTokens.bleToken]).expect(200), reference, 'V chama');
    // M, que criou o par, também: Y não casa com M.
    await reportTouch(t, y, [mTokens.bleToken]).expect(200);
    expectSameAs(await reportTouch(t, m, [yTokens.bleToken]).expect(200), reference, 'M chama');
    expect(t.proximity.claims).toEqual(['created', 'busy', 'busy', 'busy', 'busy']);
    expect(await hasPair(v, x)).toBe(false);
    expect(await hasPair(m, y)).toBe(false);
    expect(owedKeys()).toEqual([]);

    // Passado o ocupado, V e X casam.
    t.clock.advance(BUSY_MS);
    const vNow = await issueTokens(t, v);
    const xNow = await issueTokens(t, x);
    await reportTouch(t, x, [vNow.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, v, [xNow.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ handle: 'xavier', token: xNow.bleToken }),
    ]);
    expect(t.proximity.claims.at(-1)).toBe('created');
  });

  it('[PROX-54] dois relatos simultâneos do mesmo par (HTTP em paralelo), 5 rodadas: um só casamento; cada lado vê o outro exatamente uma vez (na mesma chamada ou na seguinte); nunca dois pares nem dois cartões devidos; cada conta soma 1', async () => {
    for (let round = 0; round < 5; round++) {
      t.proximity.claims.length = 0;
      const a = await person(t);
      const b = await person(t);
      const aTokens = await issueTokens(t, a);
      const bTokens = await issueTokens(t, b);
      // Os dois aparelhos perceberam o encosto ao mesmo tempo: as duas observações já existem.
      const now = t.clock.now().getTime();
      const windowMs = 5 * SECOND;
      await t.proximity.recordTouch(
        a.user.id,
        b.user.id,
        hashProximityToken(bTokens.bleToken),
        now,
        windowMs,
      );
      await t.proximity.recordTouch(
        b.user.id,
        a.user.id,
        hashProximityToken(aTokens.bleToken),
        now,
        windowMs,
      );
      const [forA, forB] = await Promise.all([
        reportTouch(t, a, [bTokens.bleToken]).expect(200),
        reportTouch(t, b, [aTokens.bleToken]).expect(200),
      ]);
      t.clock.advance(SECOND);
      const nextA = await reportTouch(t, a, [bTokens.bleToken]).expect(200);
      const nextB = await reportTouch(t, b, [aTokens.bleToken]).expect(200);
      const label = `rodada ${String(round)}`;
      expect(
        t.proximity.claims.filter((claim) => claim === 'created'),
        label,
      ).toHaveLength(1);
      expect(
        t.proximity.claims.every((claim) => claim === 'created' || claim === 'busy'),
        label,
      ).toBe(true);
      expect([...touchItems(forA), ...touchItems(nextA)], label).toEqual([
        expect.objectContaining({ token: bTokens.bleToken, handle: b.user.handle }),
      ]);
      expect([...touchItems(forB), ...touchItems(nextB)], label).toEqual([
        expect.objectContaining({ token: aTokens.bleToken, handle: a.user.handle }),
      ]);
      expect(owedKeys(), label).toEqual([]);
      expect(
        t.proximity.entries().filter((entry) => entry.key.startsWith('prox:m:')),
        label,
      ).toHaveLength(1);
      expect(await pairCountersOnce(a), label).toEqual({ hour: 1, day: 1 });
      expect(await pairCountersOnce(b), label).toEqual({ hour: 1, day: 1 });
      t.clock.advance(PAIR_MS);
    }
  });
});

describe('sinal de abuso: bloqueio logo depois do encosto (ADR 0012, A2-3; A2 rev. 1, R1-6)', () => {
  /** Assunto do e-mail do sinal (`proximityAbuseEmail`). */
  const signals = () =>
    t.outbox.sent.filter((message) => message.subject.startsWith('Sinal no Conectar'));

  it('[PROX-55] bloqueio gravado com o par vivo soma para quem foi bloqueado, também entre desconhecidos (PROX-61); depois de 60 s grava sem somar; sem par e sem ver o perfil não grava nem soma; Valkey fora no sinal → 204, gravado, nada soma; no 3º, um e-mail ("recebeu 3 bloqueios") com o @ e sem a outra parte; o 4º não repete', async () => {
    const mauro = await person(t, 'mauro.m');
    const victims: Person[] = [];
    for (let index = 1; index <= 7; index++) {
      victims.push(await person(t, `vitima${String(index)}`));
    }
    // A 3ª e a 7ª são desconhecidas: não veem o perfil de Mauro.
    for (const [index, victim] of victims.entries()) {
      if (index !== 2 && index !== 6) {
        await connect(t.database.db, victim.user, mauro.user);
      }
    }
    const blockMauro = (victim: Person) =>
      t.http.post('/v1/me/blocks').set(victim.headers).send({ handle: 'mauro.m' }).expect(204);
    const blockRows = async () =>
      (await t.database.db.select().from(blocks)).filter((row) => row.blockedId === mauro.user.id);

    const [v1, v2, v3, v4, v5, v6, v7] = victims as [
      Person,
      Person,
      Person,
      Person,
      Person,
      Person,
      Person,
    ];
    // 1: com o par vivo → soma 1.
    await touch(t, v1, mauro);
    await blockMauro(v1);
    rest();
    // 2: 60 s depois do casamento (par vencido) → grava, mas não soma.
    await touch(t, v2, mauro);
    t.clock.advance(PAIR_MS);
    await blockMauro(v2);
    rest();
    // 3: desconhecida com o par vivo (o cartão do encosto) → grava e soma 2.
    await touch(t, v3, mauro);
    await blockMauro(v3);
    expect((await blockRows()).map((row) => row.blockerId)).toContain(v3.user.id);
    rest();
    // 4: Valkey fora no sinal → o bloqueio é gravado e responde 204; nada soma.
    await touch(t, v4, mauro);
    t.proximity.failing.add('countBlockSignal');
    await blockMauro(v4);
    t.proximity.failing.clear();
    expect(signals()).toEqual([]);
    rest();
    // 5: soma 3 → um e-mail.
    await touch(t, v5, mauro);
    await blockMauro(v5);
    expect(signals()).toHaveLength(1);
    rest();
    // 6: soma 4 → não repete.
    await touch(t, v6, mauro);
    await blockMauro(v6);
    rest();
    // 7: desconhecida sem par → 204 sem gravar e sem somar (A-05).
    await blockMauro(v7);

    expect((await blockRows()).map((row) => row.blockerId).sort()).toEqual(
      [v1, v2, v3, v4, v5, v6].map((victim) => victim.user.id).sort(),
    );
    expect(t.proximity.blockSignals).toEqual([
      { blocker: 1, blocked: 1 },
      null,
      { blocker: 1, blocked: 2 },
      { blocker: 1, blocked: 3 },
      { blocker: 1, blocked: 4 },
    ]);
    const [signal] = signals();
    expect(signals()).toHaveLength(1);
    expect(signal!.subject).toBe(
      'Sinal no Conectar: @mauro.m recebeu 3 bloqueios logo depois de encostar',
    );
    expect(signal!.text).toContain('Conta: @mauro.m');
    expect(signal!.text).toContain(
      'Sinal: recebeu 3 bloqueios até 60 s depois de um encosto, nos últimos 7 dias.',
    );
    expect(signal!.text).toContain('com blocked_id igual ao id de @mauro.m');
    expect(signal!.text).not.toContain('3 pessoas');
    for (const victim of victims) {
      expect(`${signal!.subject}\n${signal!.text}`).not.toContain(victim.user.handle);
      expect(`${signal!.subject}\n${signal!.text}`).not.toContain(victim.user.id);
    }
    expect(`${signal!.subject}\n${signal!.text}`).not.toContain(mauro.user.id);
  });

  it('[PROX-55] quem faz 3 bloqueios logo depois de encostar também vira sinal ("fez 3 bloqueios"), sem o @ das outras', async () => {
    const mauro = await person(t, 'mauro.b');
    const others: Person[] = [];
    for (let index = 1; index <= 3; index++) {
      const other = await person(t, `conexao${String(index)}`);
      await connect(t.database.db, other.user, mauro.user);
      others.push(other);
    }
    for (const other of others) {
      await touch(t, other, mauro);
      await t.http
        .post('/v1/me/blocks')
        .set(mauro.headers)
        .send({ handle: other.user.handle })
        .expect(204);
      rest();
    }
    const sent = signals();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe(
      'Sinal no Conectar: @mauro.b fez 3 bloqueios logo depois de encostar',
    );
    expect(sent[0]!.text).toContain(
      'Sinal: fez 3 bloqueios até 60 s depois de um encosto, nos últimos 7 dias.',
    );
    expect(sent[0]!.text).toContain('com blocker_id igual ao id de @mauro.b');
    for (const other of others) {
      expect(`${sent[0]!.subject}\n${sent[0]!.text}`).not.toContain(other.user.handle);
    }
  });
});

describe('o cartão devido sai antes de qualquer recusa (ADR 0012, A2 rev. 1, R1-4)', () => {
  /**
   * V relata M, faz `extra` relatos sem par (somam no limite de 60 por minuto) e M casa: o cartão de
   * M fica devido a V. Tudo no mesmo instante do relógio de teste.
   */
  async function owedTo(v: Person, m: Person, extra: number) {
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);
    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    for (let index = 0; index < extra; index++) {
      await reportTouch(t, v, [UNKNOWN_TOKEN]).expect(200);
    }
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toHaveLength(1);
    expect(owedKeys()).toEqual([proximityKeys.owed(v.user.id)]);
    return { vTokens, mTokens };
  }

  it('[PROX-60] [PROX-34] acima de 60 relatos no minuto, o relato recebe o cartão devido (200, não 429) e a entrega não soma no limite; sem cartão, o 429 de sempre', async () => {
    // 60 relatos no minuto (1 + 59); o 61º recebe o cartão.
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const { mTokens } = await owedTo(v, m, 59);
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: mTokens.bleToken, handle: 'mauro', pairExpiresInS: 55 }),
    ]);
    expect(owedKeys()).toEqual([]);
    // Sem cartão: o relato seguinte é o 61º que conta → 429.
    const limited = await reportTouch(t, v, [UNKNOWN_TOKEN]).expect(429);
    expect(ErrorResponseSchema.parse(limited.body).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // A entrega não soma: com 59 relatos antes do cartão, o relato depois dele é o 60º (200), e só
    // o próximo dá 429.
    const w = await person(t, 'wanda');
    const n = await person(t, 'nina');
    const { mTokens: nTokens } = await owedTo(w, n, 58);
    expect(touchItems(await reportTouch(t, w, [nTokens.bleToken]).expect(200))).toHaveLength(1);
    await reportTouch(t, w, [UNKNOWN_TOKEN]).expect(200);
    await reportTouch(t, w, [UNKNOWN_TOKEN]).expect(429);
  });

  it('[PROX-60] [PROX-34] com a proximidade bloqueada (20 falhas) ou sem a tela aberta, o relato recebe o cartão devido (200); sem cartão, 429 e 409 como sempre; Valkey fora na entrega → 503 (mesmo com a proximidade bloqueada), e o cartão continua guardado', async () => {
    // Proximidade bloqueada.
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const { mTokens } = await owedTo(v, m, 0);
    await t.proximity.lock(v.user.id, 15 * MINUTE);
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: mTokens.bleToken, handle: 'mauro' }),
    ]);
    const locked = await reportTouch(t, v, [mTokens.bleToken]).expect(429);
    expect(ErrorResponseSchema.parse(locked.body).code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(13 * 60);

    // Tela fechada: a tela de W (30 s) fecha, e o cartão devido (60 s) continua lá.
    const w = await person(t, 'wanda');
    const n = await person(t, 'nina');
    const { mTokens: nTokens } = await owedTo(w, n, 0);
    t.clock.advance(31 * SECOND);
    expect(await t.proximity.isScreenOpen(w.user.id)).toBe(false);
    expect(touchItems(await reportTouch(t, w, [nTokens.bleToken]).expect(200))).toEqual([
      // O token venceu (30 s), mas o hash é o do casamento: é o rótulo. Faltam 29 s → 25.
      expect.objectContaining({ token: nTokens.bleToken, handle: 'nina', pairExpiresInS: 25 }),
    ]);
    const closed = await reportTouch(t, w, [nTokens.bleToken]).expect(409);
    expect(ErrorResponseSchema.parse(closed.body).code).toBe('PROXIMITY_SCREEN_CLOSED');

    // Valkey fora na entrega: 503, e não o 429 do bloqueio (a entrega vem antes); o cartão fica.
    const p = await person(t, 'paula');
    const q = await person(t, 'quintino');
    const { mTokens: qTokens } = await owedTo(p, q, 0);
    await t.proximity.lock(p.user.id, 15 * MINUTE);
    t.proximity.failing.add('takeOwedCard');
    expect((await reportTouch(t, p, [qTokens.bleToken]).expect(503)).body).toEqual(UNAVAILABLE);
    expect(owedKeys()).toEqual([proximityKeys.owed(p.user.id)]);
    t.proximity.failing.clear();
    expect(touchItems(await reportTouch(t, p, [qTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: qTokens.bleToken, handle: 'quintino' }),
    ]);
  });
});

describe('quanto falta para o par vencer (ADR 0012, A2 rev. 1, R1-10)', () => {
  it('[PROX-64] pairExpiresInS, em degraus de 5 s contados do casamento: 55 no casamento na hora e no cartão devido entregue até 4,999 s depois (os dois lados, o mesmo valor); 50 de 5 a 9,999 s; 5 com 54,999 s; 0 de 55 s até o fim do par (nunca negativo)', async () => {
    const cases: [delayMs: number, expected: number][] = [
      [0, 55],
      [4_999, 55],
      [5_000, 50],
      [9_999, 50],
      [30_000, 25],
      [54_999, 5],
      [55_000, 0],
      [PAIR_MS - 1, 0],
    ];
    for (const [delayMs, expected] of cases) {
      const v = await person(t);
      const m = await person(t);
      const vTokens = await issueTokens(t, v);
      const mTokens = await issueTokens(t, m);
      await reportTouch(t, v, [mTokens.bleToken]).expect(200);
      const [card] = touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200));
      expect(card!.pairExpiresInS, 'casamento na hora').toBe(55);
      t.clock.advance(delayMs);
      // O cartão devido sai mesmo com a tela de V já fechada (R1-4, PROX-60).
      const [owed] = touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200));
      expect({ delayMs, pairExpiresInS: owed!.pairExpiresInS }).toEqual({
        delayMs,
        pairExpiresInS: expected,
      });
      t.clock.advance(PAIR_MS);
    }
  });

  it('[PROX-64] a renovação (encostar de novo com o par vivo, passado o ocupado) volta a 55 nos dois lados', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    await touch(t, v, m);
    t.clock.advance(20 * SECOND);
    const { cardOfA, cardOfB } = await touch(t, v, m);
    expect(t.proximity.claims).toEqual(['created', 'renewed']);
    expect([cardOfA.pairExpiresInS, cardOfB.pairExpiresInS]).toEqual([55, 55]);
  });
});
