// E2E do Adendo A2 da ADR 0012 (teto de pessoas novas, revelação simétrica garantida e uma pessoa
// por vez), da revisão 1 (prazo deslizante, cartão devido antes das recusas, `pairExpiresInS`) e
// do sinal de abuso (A2-3): testes.md PROX-45, 46, 48 a 55, 60 e 64, e (A3) 66 e 67. Bloquear e
// denunciar pelo cartão e o sinal por sentido (PROX-61 a 63) ficam em
// `proximity-card-actions.e2e-spec.ts`. Tudo
// pelas rotas de verdade (touches, bloqueio, logout, exclusão de conta, pedido `ble`), com a
// política em SQL e o fake do Redis sobre o relógio de teste (sem `sleep`). O `TestProximityStore`
// registra o resultado de cada casamento (`claims`): a resposta HTTP é a mesma para teto, ocupado e
// não mútuo (PROX-46), então o teste confere também **por que** o encosto não confirmou.
//
// (ADR 0012, A3-1) Todo relato com token válido, do canal `ble` e de outra conta, chega ao script do
// casamento: o primeiro relato de um encosto volta `gone` (o outro ainda não relatou) e o par
// recusado pela política volta `refused`. Os `claims` abaixo contam esses também. (A3-2) A primeira
// entrega do cartão devido não o apaga: ele fica marcado (`"!…"`) e é entregue de novo à mesma
// pessoa por até 10 s. Os casos novos do A3 (PROX-66 e PROX-67) ficam no fim do arquivo, com as
// correções dos BAIXOS 1 e 2 do `seguranca` (A3-8): a política do `touches` lê as duas linhas do
// `findTouchPair` (testado também direto, contra o banco do teste, no último bloco) e o rótulo da
// reentrega só confere o hash guardado, sem o `findRecent`.
//
// Ficam só no unitário (`proximity.service.spec.ts` e `proximity.store.spec.ts`), por não terem
// caminho pela rota: o `gone` entre o relato e o casamento (a observação vencendo durante a consulta
// ao banco), o Valkey lento (> 500 ms) no sinal de abuso, a conta excluída antes do e-mail do sinal
// e o valor de `prox:o` no formato antigo (também no Valkey, `real-services`, PROX-56).
import { blocks, connectionRequests, eq, inArray, type UserRow, users } from '@sussurro/db';
import { block, connect, createUser, TEST_PASSWORD } from '@sussurro/db/testing';
import { ErrorResponseSchema, type ProximityToken } from '@sussurro/shared';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  generateProximityToken,
  hashProximityToken,
} from '../../src/modules/proximity/proximity-token.js';
import {
  ProximityRepository,
  type TouchPairRow,
} from '../../src/modules/proximity/proximity.repository.js';
import { PROXIMITY_TOUCH_CAPPED } from '../../src/modules/proximity/proximity.service.js';
import {
  proximityKeys,
  TOUCH_PAIRS_DAY_MS,
  TOUCH_PAIRS_HOUR_MS,
  type TouchClaim,
} from '../../src/modules/proximity/proximity.store.js';
import type { RecordedProximityCall } from '../../src/testing/test-proximity.store.js';
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

/** Ordem crescente de id (o banco não promete a ordem das linhas). */
function byId(first: { id: string }, second: { id: string }): number {
  return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
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
    // A3-1: o primeiro relato de cada encosto também chega ao script (`gone`: o outro ainda não
    // relatou); a entrega do cartão devido, não (sai antes).
    expect(t.proximity.claims).toEqual([
      'gone',
      'created',
      'gone',
      'renewed',
      ...Array.from({ length: 9 }, () => ['gone', 'created']).flat(),
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
    // seguinte do outro): 4 tentativas, todas no teto, cada uma depois do `gone` do primeiro relato.
    expect(t.proximity.claims.slice(-6)).toEqual([
      'gone',
      'capped',
      'capped',
      'gone',
      'capped',
      'capped',
    ]);
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

  it('[PROX-46] [PROX-66] a política vem antes do teto: par recusado por bloqueio (nos dois sentidos) ou conta excluída chega ao script do casamento e volta refused (A3-1), sem gravar nada nem tocar os contadores; a resposta é a de não mútuo, byte a byte, para os dois lados', async () => {
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

    // A3-1: cada relato chegou ao script. Por par bloqueado, dois encostos no mesmo instante: o 1º
    // relato do 1º encosto volta `gone` (o outro ainda não relatou); os outros cinco, `refused`
    // (as observações dos dois existem, e a política recusou). A conta excluída: o relato dela,
    // antes da exclusão, volta `gone`; o de Ana, depois, `refused`.
    const blockedPair = ['gone', ...Array.from({ length: 5 }, () => 'refused')];
    expect(t.proximity.claims).toEqual([...blockedPair, ...blockedPair, 'gone', 'refused']);
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

    // 30 s: B relata V. O primeiro relato de V tem 30 s, fora da janela: não casa. Os 31 relatos
    // chegaram ao script (A3-1), e todos voltaram `gone`.
    expect((await reportTouch(t, b, [vTokens.bleToken]).expect(200)).body).toEqual({ items: [] });
    expect(t.proximity.claims).toEqual(Array.from({ length: 31 }, () => 'gone'));

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
    // Os três relatos de V, sem o de B, voltam `gone` (A3-1); o de B casa.
    expect(t.proximity.claims).toEqual(['gone', 'gone', 'gone', 'created']);
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
    // 6 s: B percebe o encosto atrasado; o primeiro relato de V tem 6 s, fora da janela. Os 6
    // relatos de V e o de B voltam `gone` (A3-1).
    expect((await reportTouch(t, b, [vTokens.bleToken]).expect(200)).body).toEqual({ items: [] });
    const missed = Array.from({ length: 7 }, () => 'gone');
    expect(t.proximity.claims).toEqual(missed);

    // 7 s: o relato de V casa com a observação nova de B (aberta aos 6 s).
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, v, [bTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: bTokens.bleToken, handle: 'bruno.b' }),
    ]);
    expect(t.proximity.claims).toEqual([...missed, 'created']);
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
    // Os 13 relatos de V e os 3 de M chegaram ao script (A3-1): todos `gone`.
    expect(t.proximity.claims).toEqual(Array.from({ length: 16 }, () => 'gone'));
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
    // Os 10 relatos de V (0 a 9 s) e o de M aos 9,9 s: todos `gone` (A3-1).
    const missed = Array.from({ length: 11 }, () => 'gone');
    expect(t.proximity.claims).toEqual(missed);

    t.clock.advance(start + 10 * SECOND - now());
    expect(touchItems(await reportTouch(t, v, [tM]).expect(200))).toEqual([
      expect.objectContaining({ token: tM, handle: 'mauro', pairExpiresInS: 55 }),
    ]);
    expect(t.proximity.claims).toEqual([...missed, 'created']);
    t.clock.advance(900);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: vTokens.bleToken, handle: 'vera', pairExpiresInS: 55 }),
    ]);
    // A entrega do cartão devido não chega ao script.
    expect(t.proximity.claims).toEqual([...missed, 'created']);
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
    // Os 16 relatos de V (tM, tX, tY e tM) voltam `gone` (A3-1); o de M aos 16 s casa.
    expect(t.proximity.claims).toEqual([...Array.from({ length: 16 }, () => 'gone'), 'created']);
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, v, [tM]).expect(200))).toEqual([
      expect.objectContaining({ token: tM, handle: 'mauro', pairExpiresInS: 55 }),
    ]);
  });
});

describe('revelação simétrica garantida (ADR 0012, A2-2)', () => {
  it('[PROX-49] [PROX-67] M casa, recebe o cartão de V e bloqueia V pela rota: o relato seguinte de V recebe o cartão de M (@, nome, foto e alreadyConnected do casamento, pairExpiresInS) com o token relatado; o pedido ble de V para M → 400 genérico, nada gravado; os relatos até 10 s depois da 1ª entrega recebem o mesmo cartão (A3-2), e depois, []; entre desconhecidos, pela rota com o par vivo (PROX-61), o mesmo', async () => {
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
    const deliveredAt = now();
    const delivered = await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    const cardOfM = (pairExpiresInS: number) => ({
      token: mTokens.bleToken,
      handle: 'mauro',
      name: m.user.name,
      avatarUrl: expect.stringContaining(avatarKey) as unknown,
      alreadyConnected: true,
      pairExpiresInS,
    });
    // Casamento há 1 s: o mesmo degrau do cartão na hora (PROX-64).
    expect(touchItems(delivered)).toEqual([cardOfM(55)]);
    // O bloqueio vale para o pedido: 400 genérico, nenhum pedido gravado.
    const refused = await requestConnection(t, v, mTokens.bleToken, 'ble').expect(400);
    expect(ErrorResponseSchema.parse(refused.body).code).toBe('PROXIMITY_TOKEN_INVALID');
    expect(await t.database.db.select().from(connectionRequests)).toEqual([]);
    // A3-2: a 1ª entrega não apaga o cartão; os relatos até 10 s depois recebem o mesmo (a resposta
    // pode ter se perdido na rede), mesmo com o bloqueio, e o prazo é recalculado do casamento.
    t.clock.advance(SECOND);
    expect(valueOf(proximityKeys.owed(v.user.id))).toMatch(/^!/);
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      cardOfM(55),
    ]);
    t.clock.advance(deliveredAt + BUSY_MS - 1 - now());
    // Casamento há 10,999 s → 45.
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      cardOfM(45),
    ]);
    // 10 s depois da 1ª entrega: acabou.
    t.clock.advance(1);
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
  it('[PROX-53] [PROX-46] [PROX-67] com um cartão a receber, ninguém casa com V (quem tenta recebe a resposta de não mútuo, byte a byte); V recebe o cartão de M, nunca o de X; até 10 s depois, X não casa com V, e V, quando chama, recebe de novo o cartão de M (reentrega, A3-2); quem cria o par também fica 10 s ocupado; depois, casa', async () => {
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

    // V recebeu um cartão: ocupada por 10 s. X chama → ocupado. V chama → (A3-2) recebe de novo o
    // cartão de M, nunca o de X, com o rótulo recalculado (outro token nunca emitido), e o relato
    // nem chega ao casamento. V chamando com o ocupado e sem a reentrega (o cartão que chega tarde,
    // com menos de 10 s de vida): PROX-67, no fim do arquivo.
    t.clock.advance(SECOND);
    expectSameAs(await reportTouch(t, x, [vTokens.bleToken]).expect(200), reference, 'X chama');
    const [again] = touchItems(await reportTouch(t, v, [xTokens.bleToken]).expect(200));
    expect(again).toEqual({ ...card, token: again!.token });
    expect([xTokens.bleToken, mTokens.bleToken]).not.toContain(again!.token);
    // M, que criou o par, também: Y não casa com M.
    await reportTouch(t, y, [mTokens.bleToken]).expect(200);
    expectSameAs(await reportTouch(t, m, [yTokens.bleToken]).expect(200), reference, 'M chama');
    // V relata X e M (`gone`: nenhum dos dois tinha relatado V), M casa, X tenta duas vezes (a 2ª
    // com o cartão já entregue, à espera da reentrega), Y relata M (`gone`) e M tenta com Y.
    expect(t.proximity.claims).toEqual(['gone', 'gone', 'created', 'busy', 'busy', 'gone', 'busy']);
    expect(await hasPair(v, x)).toBe(false);
    expect(await hasPair(m, y)).toBe(false);
    // O cartão de M continua com V, marcado como entregue, até 10 s depois da 1ª entrega.
    expect(owedKeys()).toEqual([proximityKeys.owed(v.user.id)]);
    expect(valueOf(proximityKeys.owed(v.user.id))).toMatch(/^!/);

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

  it('[PROX-54] [PROX-67] dois relatos simultâneos do mesmo par (HTTP em paralelo), 5 rodadas: um só casamento; cada lado recebe o cartão do outro na mesma chamada ou na seguinte (quem cria, só na própria; o outro, se o recebeu na própria, recebe a reentrega na seguinte, A3-2); nunca dois pares nem dois cartões devidos; cada conta soma 1', async () => {
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
      // Quem criou o par recebe o cartão do outro só na própria chamada (não há cartão devido a
      // ele). O outro recebe o cartão de quem criou na própria chamada (se o `takeOwedCard` dele
      // rodou depois do casamento) e, aí, de novo na seguinte (a reentrega, A3-2); senão, só na
      // seguinte. Nunca um cartão de outra pessoa nem um lado sem cartão.
      // O cartão de quem criou continua com o outro, já entregue (`!`), à espera da reentrega: é
      // por ele que o teste sabe quem criou, sem olhar as respostas.
      const [owedKey] = owedKeys();
      expect(owedKeys(), label).toHaveLength(1);
      expect(valueOf(owedKey!), label).toMatch(/^!/);
      const cardOfB = expect.objectContaining({
        token: bTokens.bleToken,
        handle: b.user.handle,
      }) as unknown;
      const cardOfA = expect.objectContaining({
        token: aTokens.bleToken,
        handle: a.user.handle,
      }) as unknown;
      const [creator, other] =
        owedKey === proximityKeys.owed(b.user.id)
          ? [[forA, nextA, cardOfB] as const, [forB, nextB, cardOfA] as const]
          : [[forB, nextB, cardOfA] as const, [forA, nextA, cardOfB] as const];
      expect([...touchItems(creator[0]), ...touchItems(creator[1])], label).toEqual([creator[2]]);
      expect(touchItems(other[1]), `${label}: o outro, na seguinte`).toEqual([other[2]]);
      expect(touchItems(other[0]), `${label}: o outro, na própria`).toEqual(
        touchItems(other[0]).length === 0 ? [] : [other[2]],
      );
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
    // O cartão de M espera V, ainda não entregue (sem a marca `!` do A3-2).
    expect(valueOf(proximityKeys.owed(v.user.id))).toMatch(/^[^!]/);
    return { vTokens, mTokens };
  }

  it('[PROX-60] [PROX-34] [PROX-67] acima de 60 relatos no minuto, o relato recebe o cartão devido (200, não 429) e a 1ª entrega não soma no limite; a reentrega soma (A3-2: o 61º → 429, e o cartão continua); sem cartão, o 429 de sempre', async () => {
    // 60 relatos no minuto (1 + 59); o 61º recebe o cartão.
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const { mTokens } = await owedTo(v, m, 59);
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: mTokens.bleToken, handle: 'mauro', pairExpiresInS: 55 }),
    ]);
    // Sem cartão (passados os 10 s da reentrega, ainda no mesmo minuto): o relato seguinte é o 61º
    // que conta → 429.
    t.clock.advance(BUSY_MS);
    expect(owedKeys()).toEqual([]);
    const limited = await reportTouch(t, v, [UNKNOWN_TOKEN]).expect(429);
    expect(ErrorResponseSchema.parse(limited.body).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // A 1ª entrega não soma, e a reentrega soma: com 59 relatos antes do cartão, a 1ª reentrega é o
    // 60º (200, com o cartão, o rótulo recalculado) e a 2ª, o 61º (429, sem mexer no cartão).
    const w = await person(t, 'wanda');
    const n = await person(t, 'nina');
    const { mTokens: nTokens } = await owedTo(w, n, 58);
    expect(touchItems(await reportTouch(t, w, [nTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: nTokens.bleToken, handle: 'nina' }),
    ]);
    const marked = valueOf(proximityKeys.owed(w.user.id));
    const [again] = touchItems(await reportTouch(t, w, [UNKNOWN_TOKEN]).expect(200));
    expect(again).toMatchObject({ handle: 'nina' });
    expect([UNKNOWN_TOKEN, nTokens.bleToken]).not.toContain(again!.token);
    const over = await reportTouch(t, w, [nTokens.bleToken]).expect(429);
    expect(ErrorResponseSchema.parse(over.body).code).toBe('RATE_LIMITED');
    expect(valueOf(proximityKeys.owed(w.user.id))).toBe(marked);
  });

  it('[PROX-60] [PROX-34] [PROX-67] com a proximidade bloqueada (20 falhas) ou sem a tela aberta, o relato recebe o cartão devido (200), e a reentrega também (só passa pelo limite, A3-2); sem cartão, 429 e 409 como sempre; Valkey fora na entrega → 503 (mesmo com a proximidade bloqueada), e o cartão continua guardado, sem a marca', async () => {
    // Proximidade bloqueada.
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const { mTokens } = await owedTo(v, m, 0);
    await t.proximity.lock(v.user.id, 15 * MINUTE);
    for (const label of ['1ª entrega', 'reentrega']) {
      expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200)), label).toEqual([
        expect.objectContaining({ token: mTokens.bleToken, handle: 'mauro' }),
      ]);
    }
    // Sem cartão (passados os 10 s): o 429 do bloqueio.
    t.clock.advance(BUSY_MS);
    const locked = await reportTouch(t, v, [mTokens.bleToken]).expect(429);
    expect(ErrorResponseSchema.parse(locked.body).code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(13 * 60);

    // Tela fechada: a tela de W (30 s) fecha, e o cartão devido (60 s) continua lá.
    const w = await person(t, 'wanda');
    const n = await person(t, 'nina');
    const { mTokens: nTokens } = await owedTo(w, n, 0);
    t.clock.advance(31 * SECOND);
    expect(await t.proximity.isScreenOpen(w.user.id)).toBe(false);
    for (const label of ['1ª entrega', 'reentrega']) {
      expect(touchItems(await reportTouch(t, w, [nTokens.bleToken]).expect(200)), label).toEqual([
        // O token venceu (30 s), mas o hash é o do casamento: é o rótulo. Faltam 29 s → 25.
        expect.objectContaining({ token: nTokens.bleToken, handle: 'nina', pairExpiresInS: 25 }),
      ]);
    }
    // Sem cartão (passados os 10 s): o 409 da tela fechada.
    t.clock.advance(BUSY_MS);
    const closed = await reportTouch(t, w, [nTokens.bleToken]).expect(409);
    expect(ErrorResponseSchema.parse(closed.body).code).toBe('PROXIMITY_SCREEN_CLOSED');

    // Valkey fora na entrega: 503, e não o 429 do bloqueio (a entrega vem antes); o cartão fica,
    // sem a marca de entregue (a falha não conta como 1ª entrega).
    const p = await person(t, 'paula');
    const q = await person(t, 'quintino');
    const { mTokens: qTokens } = await owedTo(p, q, 0);
    await t.proximity.lock(p.user.id, 15 * MINUTE);
    t.proximity.failing.add('takeOwedCard');
    expect((await reportTouch(t, p, [qTokens.bleToken]).expect(503)).body).toEqual(UNAVAILABLE);
    expect(owedKeys()).toEqual([proximityKeys.owed(p.user.id)]);
    expect(valueOf(proximityKeys.owed(p.user.id))).toMatch(/^[^!]/);
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
    // O primeiro relato de cada encosto volta `gone` (A3-1): M ainda não tinha relatado.
    expect(t.proximity.claims).toEqual(['gone', 'created', 'gone', 'renewed']);
    expect([cardOfA.pairExpiresInS, cardOfB.pairExpiresInS]).toEqual([55, 55]);
  });
});

describe('o mesmo caminho para todo token válido (ADR 0012, A3-1, R22)', () => {
  /**
   * As idas de um relato com token válido, do canal `ble` e de outra conta, sem cartão devido: as
   * mesmas, na mesma ordem, em todo caminho (não mútuo, recusa pela política, teto, ocupado e
   * casamento). O `findTouchPair` é a consulta da política no Postgres (BAIXO 1 do `seguranca`: as
   * duas linhas sempre, com os fatos em colunas); o `createTestApp` o anota na mesma lista, e
   * também o `findNearby`, que no `touches` não pode aparecer. É o teste de tempo do R22 sem medir a
   * rede.
   */
  const TOUCH_PATH: readonly RecordedProximityCall[] = [
    'takeOwedCard',
    'lockRemainingMs',
    'hit',
    'isScreenOpen',
    'findValid',
    'recordTouch',
    'findTouchPair',
    'claimTouchPair',
  ];

  interface Measured {
    name: string;
    calls: RecordedProximityCall[];
    claims: TouchClaim[];
    response: Response;
  }

  /** O relato medido: as idas e o resultado do script só deste relato, e a resposta. */
  async function measured(name: string, who: Person, token: string): Promise<Measured> {
    t.proximity.calls.length = 0;
    const claimsBefore = t.proximity.claims.length;
    const response = await reportTouch(t, who, [token]).expect(200);
    return {
      name,
      calls: [...t.proximity.calls],
      claims: t.proximity.claims.slice(claimsBefore),
      response,
    };
  }

  /**
   * V e O com a tela aberta, depois de `setup`; O já relatou V (o encosto é mútuo quando V relatar
   * O, na mesma hora).
   */
  async function oReportedV(setup?: (v: Person, o: Person) => Promise<unknown>) {
    const v = await person(t);
    const o = await person(t);
    await setup?.(v, o);
    const vTokens = await issueTokens(t, v);
    const oTokens = await issueTokens(t, o);
    await reportTouch(t, o, [vTokens.bleToken]).expect(200);
    return { v, o, vTokens, oTokens };
  }

  it('[PROX-66] [PROX-46] não mútuo, recusa pela política (V bloqueou O, O bloqueou V, O excluiu a conta depois de relatar), capped, busy e casamento (created e renewed): as mesmas idas, na mesma ordem, com o findTouchPair e o claimTouchPair uma vez cada (nunca o findNearby); não mútuo, recusa, teto e ocupado com o mesmo corpo, byte a byte', async () => {
    const reference = await notMutual();
    const notMatched: { outcome: TouchClaim; result: Measured }[] = [];
    const matched: { outcome: TouchClaim; result: Measured; handle: string }[] = [];

    // B. Não mútuo: O nunca relatou V.
    {
      const v = await person(t);
      const o = await person(t);
      await issueTokens(t, v);
      const oTokens = await issueTokens(t, o);
      notMatched.push({
        outcome: 'gone',
        result: await measured('não mútuo', v, oTokens.bleToken),
      });
    }

    // C. Recusa pela política, com as duas observações na janela.
    {
      const { v, oTokens } = await oReportedV((v, o) => block(t.database.db, v.user, o.user));
      notMatched.push({
        outcome: 'refused',
        result: await measured('V bloqueou O', v, oTokens.bleToken),
      });
    }
    {
      const { v, oTokens } = await oReportedV((v, o) => block(t.database.db, o.user, v.user));
      notMatched.push({
        outcome: 'refused',
        result: await measured('O bloqueou V', v, oTokens.bleToken),
      });
    }
    {
      // Conta excluída depois do relato dela (os tokens continuam no Redis; quem barra é a política).
      const { v, o, oTokens } = await oReportedV();
      await t.database.db
        .update(users)
        .set({ deletedAt: t.clock.now() })
        .where(eq(users.id, o.user.id));
      notMatched.push({
        outcome: 'refused',
        result: await measured('O excluiu a conta', v, oTokens.bleToken),
      });
    }

    // D. Teto (O já tem 10 pares novos na hora) e ocupado (O acabou de criar um par com P).
    {
      const { v, oTokens } = await oReportedV(async (_v, o) => {
        for (let index = 0; index < 10; index++) {
          await t.proximity.hit(proximityKeys.pairsPerHour(o.user.id), TOUCH_PAIRS_HOUR_MS);
        }
      });
      notMatched.push({ outcome: 'capped', result: await measured('capped', v, oTokens.bleToken) });
    }
    {
      const { v, oTokens } = await oReportedV(async (_v, o) => touch(t, await person(t), o));
      notMatched.push({ outcome: 'busy', result: await measured('busy', v, oTokens.bleToken) });
    }

    // E. Casamento: par novo e, passado o ocupado, a renovação.
    const { v, o, vTokens, oTokens } = await oReportedV();
    matched.push({
      outcome: 'created',
      result: await measured('created', v, oTokens.bleToken),
      handle: o.user.handle,
    });
    expect(touchItems(await reportTouch(t, o, [vTokens.bleToken]).expect(200))).toHaveLength(1);
    rest(BUSY_MS);
    const vAgain = await issueTokens(t, v);
    const oAgain = await issueTokens(t, o);
    await reportTouch(t, o, [vAgain.bleToken]).expect(200);
    matched.push({
      outcome: 'renewed',
      result: await measured('renewed', v, oAgain.bleToken),
      handle: o.user.handle,
    });

    for (const { outcome, result } of [...notMatched, ...matched]) {
      expect({ name: result.name, calls: result.calls, claims: result.claims }).toEqual({
        name: result.name,
        calls: TOUCH_PATH,
        claims: [outcome],
      });
    }
    for (const { result } of notMatched) {
      expectSameAs(result.response, reference, result.name);
    }
    for (const { result, handle } of matched) {
      expect(touchItems(result.response), result.name).toEqual([
        expect.objectContaining({ handle, pairExpiresInS: 55 }),
      ]);
    }
  });

  it('[PROX-66] [PROX-46] a recusa vem antes do ocupado e do teto: par bloqueado com o outro ocupado (acabou de casar com P) ou no teto → refused, não busy nem capped (o script não lê o ocupado nem os contadores), sem gravar nada', async () => {
    const reference = await notMutual();
    const busy = await oReportedV(async (v, o) => {
      await block(t.database.db, o.user, v.user);
      await touch(t, await person(t), o);
    });
    const capped = await oReportedV(async (v, o) => {
      await block(t.database.db, v.user, o.user);
      for (let index = 0; index < 10; index++) {
        await t.proximity.hit(proximityKeys.pairsPerHour(o.user.id), TOUCH_PAIRS_HOUR_MS);
      }
    });
    const results = [
      await measured('O bloqueou V e está ocupada', busy.v, busy.oTokens.bleToken),
      await measured('V bloqueou O, que está no teto', capped.v, capped.oTokens.bleToken),
    ];
    for (const result of results) {
      expect({ name: result.name, calls: result.calls, claims: result.claims }).toEqual({
        name: result.name,
        calls: TOUCH_PATH,
        claims: ['refused'],
      });
      expectSameAs(result.response, reference, result.name);
    }
    for (const { v, o } of [busy, capped]) {
      expect(await hasPair(v, o)).toBe(false);
      expect(valueOf(proximityKeys.owed(v.user.id))).toBeUndefined();
      expect(valueOf(proximityKeys.owed(o.user.id))).toBeUndefined();
      expect(valueOf(proximityKeys.busy(v.user.id))).toBeUndefined();
    }
    // Nenhum contador mudou: V continua sem par novo, e O, no teto (10), sem somar.
    expect(await pairCountersOnce(capped.v)).toEqual({ hour: 0, day: 0 });
    expect(await pairCountersOnce(capped.o)).toEqual({ hour: 10, day: 0 });
  });

  it('[PROX-66] [PROX-32] token inexistente, do QR, próprio, vencido ou revogado para no findValid (depende só do token, não da relação): sem observação, política nem casamento, com a resposta de não mútuo', async () => {
    const reference = await notMutual();
    const v = await person(t);
    const o = await person(t);
    const vTokens = await issueTokens(t, v);
    const oTokens = await issueTokens(t, o);
    const results = [
      await measured('inexistente', v, UNKNOWN_TOKEN),
      await measured('do QR', v, oTokens.qrToken),
      await measured('próprio', v, vTokens.bleToken),
    ];
    // Vencido: 30 s depois da emissão (V renova a tela).
    t.clock.advance(30 * SECOND);
    await issueTokens(t, v);
    results.push(await measured('vencido', v, oTokens.bleToken));
    // Revogado: P saiu (o logout revoga os tokens).
    const p = await person(t);
    const pTokens = await issueTokens(t, p);
    await t.http.post('/v1/auth/logout').set(p.headers).expect(204);
    results.push(await measured('revogado', v, pTokens.bleToken));

    for (const result of results) {
      expect({ name: result.name, calls: result.calls, claims: result.claims }).toEqual({
        name: result.name,
        calls: TOUCH_PATH.slice(0, 5),
        claims: [],
      });
      expectSameAs(result.response, reference, result.name);
    }
    expect(t.proximity.entries().filter((entry) => entry.key.startsWith('prox:o:'))).toEqual([]);
  });

  it('[PROX-35] [PROX-66] com o claimTouchPair fora, o relato não mútuo e o recusado pela política dão o mesmo 503 do mútuo (a falha também não distingue os caminhos), sem par, cartão devido nem ocupado; com o Valkey de volta, o encosto casa', async () => {
    const v = await person(t);
    const o = await person(t, 'otavio');
    const x = await person(t);
    const y = await person(t);
    await block(t.database.db, x.user, y.user);
    const vTokens = await issueTokens(t, v);
    const oTokens = await issueTokens(t, o);
    const xTokens = await issueTokens(t, x);
    const yTokens = await issueTokens(t, y);
    t.proximity.failing.add('claimTouchPair');

    // Não mútuo: O ainda não relatou V.
    const notMutualDown = await reportTouch(t, v, [oTokens.bleToken]).expect(503);
    // Recusado pela política: Y relata X (a observação é gravada antes do script), e X relata Y.
    await reportTouch(t, y, [xTokens.bleToken]).expect(503);
    const refusedDown = await reportTouch(t, x, [yTokens.bleToken]).expect(503);
    // Mútuo: O relata V, e V relata O de novo.
    await reportTouch(t, o, [vTokens.bleToken]).expect(503);
    const mutualDown = await reportTouch(t, v, [oTokens.bleToken]).expect(503);

    expect(notMutualDown.body).toEqual(UNAVAILABLE);
    expectSameAs(refusedDown, notMutualDown, 'recusado pela política');
    expectSameAs(mutualDown, notMutualDown, 'mútuo');
    expect(t.proximity.claims).toEqual([]);
    expect(t.proximity.entries().filter((entry) => /^prox:[mvc]:/.test(entry.key))).toEqual([]);

    // O Valkey volta: as observações gravadas antes da falha valem, e o relato de V casa.
    t.proximity.failing.clear();
    expect(touchItems(await reportTouch(t, v, [oTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ handle: 'otavio', token: oTokens.bleToken }),
    ]);
    expect(t.proximity.claims).toEqual(['created']);
  });

  it('[PROX-66] com o Postgres fora (findTouchPair), o relato não mútuo dá o mesmo 500 do mútuo (antes do A3-1, só o mútuo chegava ao banco); de volta, o encosto casa', async () => {
    const v = await person(t);
    const o = await person(t, 'olivia');
    const vTokens = await issueTokens(t, v);
    const oTokens = await issueTokens(t, o);
    const down = vi
      .spyOn(t.app.get(ProximityRepository), 'findTouchPair')
      .mockRejectedValue(new Error('Postgres fora (simulado)'));
    try {
      const notMutualDown = await reportTouch(t, v, [oTokens.bleToken]).expect(500);
      await reportTouch(t, o, [vTokens.bleToken]).expect(500);
      const mutualDown = await reportTouch(t, v, [oTokens.bleToken]).expect(500);
      expect(ErrorResponseSchema.parse(notMutualDown.body).code).toBe('INTERNAL_ERROR');
      expectSameAs(mutualDown, notMutualDown, 'mútuo com o Postgres fora');
      expect(down).toHaveBeenCalledTimes(3);
    } finally {
      down.mockRestore();
    }
    expect(t.proximity.claims).toEqual([]);
    expect(touchItems(await reportTouch(t, v, [oTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ handle: 'olivia' }),
    ]);
  });

  it('[PROX-66] [PROX-36] [PROX-46] (BAIXO 1) a recusa sai das colunas do findTouchPair, com as linhas vindas do banco: V bloqueou O, O bloqueou V, os dois sentidos, O excluiu a conta, O criadora (token só no fake) e O apagada de vez (uma linha só), com as duas observações → as mesmas idas (recordTouch → findTouchPair → claimTouchPair, refused) e o corpo do não mútuo, byte a byte, sem o @ nem o nome de ninguém', async () => {
    const reference = await notMutual();
    const ttls = { validMs: 30 * SECOND, recentMs: 120 * SECOND, screenMs: 30 * SECOND };
    const free = { personal: true, active: true, connected: false, blocked: false };
    type Facts = Partial<typeof free>;
    interface Prepared {
      v: Person;
      o: UserRow;
      oToken: string;
    }

    /** O relatou V pela rota (`oReportedV`); depois, `after` muda O direto no banco. */
    async function viaRoute(
      setup?: (v: Person, o: Person) => Promise<unknown>,
      after?: (o: Person) => Promise<unknown>,
    ): Promise<Prepared> {
      const { v, o, oTokens } = await oReportedV(setup);
      await after?.(o);
      return { v, o: o.user, oToken: oTokens.bleToken };
    }

    /**
     * O criadora: a rota não emite token para criador (PROX-08), então o token `ble` dela e a
     * observação dela sobre V vão direto no fake (a defesa em profundidade da política).
     */
    async function creatorO(): Promise<Prepared> {
      const v = await person(t);
      const o = await createUser(t.database.db, {
        accountType: 'creator',
        emailVerifiedAt: new Date(),
      });
      const vTokens = await issueTokens(t, v);
      const oToken = generateProximityToken();
      await t.proximity.issue(
        hashProximityToken(oToken),
        { userId: o.id, issuedAt: now(), channel: 'ble' },
        ttls,
      );
      await t.proximity.recordTouch(
        o.id,
        v.user.id,
        hashProximityToken(vTokens.bleToken),
        now(),
        WINDOW_MS,
      );
      return { v, o, oToken };
    }

    const softDelete = (o: Person) =>
      t.database.db.update(users).set({ deletedAt: t.clock.now() }).where(eq(users.id, o.user.id));
    const hardDelete = (o: Person) => t.database.db.delete(users).where(eq(users.id, o.user.id));
    const scenarios: {
      name: string;
      prepare: () => Promise<Prepared>;
      pair: Facts;
      /** Os fatos da linha de O, ou `null` sem a linha (conta apagada de vez). */
      ofO: Facts | null;
    }[] = [
      {
        name: 'V bloqueou O',
        prepare: () => viaRoute((v, o) => block(t.database.db, v.user, o.user)),
        pair: { blocked: true },
        ofO: {},
      },
      {
        name: 'O bloqueou V',
        prepare: () => viaRoute((v, o) => block(t.database.db, o.user, v.user)),
        pair: { blocked: true },
        ofO: {},
      },
      {
        name: 'os dois sentidos',
        prepare: () =>
          viaRoute(async (v, o) => {
            await block(t.database.db, v.user, o.user);
            await block(t.database.db, o.user, v.user);
          }),
        pair: { blocked: true },
        ofO: {},
      },
      {
        name: 'O excluiu a conta',
        prepare: () => viaRoute(undefined, softDelete),
        pair: {},
        ofO: { active: false },
      },
      { name: 'O criadora', prepare: creatorO, pair: {}, ofO: { personal: false } },
      {
        name: 'O apagada de vez',
        prepare: () => viaRoute(undefined, hardDelete),
        pair: {},
        ofO: null,
      },
    ];

    const reads = vi.spyOn(t.app.get(ProximityRepository), 'findTouchPair');
    try {
      for (const { name, prepare, pair, ofO } of scenarios) {
        const { v, o, oToken } = await prepare();
        reads.mockClear();
        const result = await measured(name, v, oToken);

        expect({ name, calls: result.calls, claims: result.claims }).toEqual({
          name,
          calls: TOUCH_PATH,
          claims: ['refused'],
        });
        expectSameAs(result.response, reference, name);
        for (const secret of [o.handle, o.name, v.user.handle, v.user.name]) {
          expect(result.response.text, name).not.toContain(secret);
        }
        // As linhas que o banco devolveu: as duas (só a de V sem a conta de O), com os fatos certos.
        expect(reads, name).toHaveBeenCalledTimes(1);
        expect(reads.mock.calls[0], name).toEqual([v.user.id, o.id]);
        const rows = (await reads.mock.results[0]!.value) as TouchPairRow[];
        const lineOf = (user: Pick<UserRow, 'id' | 'handle' | 'name'>, facts: Facts) => ({
          id: user.id,
          handle: user.handle,
          name: user.name,
          avatarKey: null,
          ...free,
          ...pair,
          ...facts,
        });
        const expected = [lineOf(v.user, {}), ...(ofO === null ? [] : [lineOf(o, ofO)])];
        expect({ name, rows: [...rows].sort(byId) }).toEqual({ name, rows: expected.sort(byId) });
      }
    } finally {
      reads.mockRestore();
    }
  });
});

describe('reentrega do cartão devido (ADR 0012, A3-2, R23)', () => {
  it('[PROX-67] a resposta da 1ª entrega se perde: o relato seguinte, em menos de 10 s, recebe o mesmo cartão (rótulo e pairExpiresInS recalculados do casamento), só passando pelo limite, sem regravar o cartão nem o ocupado; aos 10 s, acabou, e V casa com outra pessoa na hora', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const x = await person(t, 'xavier');
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);
    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toHaveLength(1);
    const cardOfM = (pairExpiresInS: number) => ({
      token: mTokens.bleToken,
      handle: 'mauro',
      name: m.user.name,
      avatarUrl: null,
      alreadyConnected: false,
      pairExpiresInS,
    });

    // 1ª entrega, 1 s depois do casamento. A resposta se perde na rede: o app não a recebe.
    t.clock.advance(SECOND);
    const deliveredAt = now();
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      cardOfM(55),
    ]);
    const marked = valueOf(proximityKeys.owed(v.user.id));
    expect(marked).toMatch(/^!/);

    // 6 s depois (7 s do casamento): o mesmo cartão, com o prazo recalculado (50). A reentrega só
    // passa pelo limite: sem bloqueio, tela, política, observação nem casamento, e nada é regravado.
    t.clock.advance(6 * SECOND);
    t.proximity.calls.length = 0;
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      cardOfM(50),
    ]);
    expect(t.proximity.calls).toEqual(['takeOwedCard', 'hit']);
    expect(valueOf(proximityKeys.owed(v.user.id))).toBe(marked);

    // 9,999 s depois da 1ª entrega (10,999 s do casamento): ainda, com 45.
    t.clock.advance(deliveredAt + BUSY_MS - 1 - now());
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      cardOfM(45),
    ]);

    // 10 s: o cartão venceu, e o ocupado também (as reentregas não o regravaram): V casa com X.
    t.clock.advance(1);
    expect(owedKeys()).toEqual([]);
    const vNow = await issueTokens(t, v);
    const xTokens = await issueTokens(t, x);
    await reportTouch(t, x, [vNow.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, v, [xTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ handle: 'xavier', token: xTokens.bleToken }),
    ]);
    expect(t.proximity.claims.at(-1)).toBe('created');
  });

  it('[PROX-67] [PROX-51] (BAIXO 2) o rótulo da reentrega só confere o hash guardado: M gira o token entre a 1ª entrega (perdida) e a reentrega, e V relata o token novo → o cartão chega com um token nunca emitido, com as idas takeOwedCard e hit só (sem findRecent), e o pedido com ele → 400 PROXIMITY_TOKEN_INVALID, nada gravado; o token de P (par vivo com V) e um inexistente, o mesmo; o token do casamento → o próprio token, e o pedido com ele vale', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const p = await person(t, 'paula');
    await touch(t, v, p);
    rest(BUSY_MS);
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);
    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toHaveLength(1);

    // 1ª entrega, com o token do casamento. A resposta se perde na rede.
    t.clock.advance(SECOND);
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: mTokens.bleToken, handle: 'mauro' }),
    ]);

    // M gira o token (o app renova a cada 20 s). O token novo é de M (o `findRecent` diria isso, e
    // na 1ª entrega ele seria o rótulo, PROX-51), mas a reentrega não pergunta.
    t.clock.advance(SECOND);
    const rotated = await issueTokens(t, m);
    expect((await t.proximity.findRecent(hashProximityToken(rotated.bleToken)))?.userId).toBe(
      m.user.id,
    );
    const pTokens = await issueTokens(t, p);
    const neverIssued: string[] = [];
    for (const [label, token] of [
      ['token girado de M', rotated.bleToken],
      ['token de P', pTokens.bleToken],
      ['inexistente', UNKNOWN_TOKEN],
    ] as const) {
      t.proximity.calls.length = 0;
      const [card] = touchItems(await reportTouch(t, v, [token]).expect(200));
      expect({ label, calls: [...t.proximity.calls] }).toEqual({
        label,
        calls: ['takeOwedCard', 'hit'],
      });
      expect({ label, card }).toEqual({
        label,
        card: {
          token: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) as unknown,
          handle: 'mauro',
          name: m.user.name,
          avatarUrl: null,
          alreadyConnected: false,
          pairExpiresInS: 55,
        },
      });
      expect(
        [rotated.bleToken, rotated.qrToken, mTokens.bleToken, pTokens.bleToken, UNKNOWN_TOKEN],
        label,
      ).not.toContain(card!.token);
      expect(await t.proximity.findRecent(hashProximityToken(card!.token)), label).toBeNull();
      neverIssued.push(card!.token);
      const refused = await requestConnection(t, v, card!.token, 'ble').expect(400);
      expect(ErrorResponseSchema.parse(refused.body).code, label).toBe('PROXIMITY_TOKEN_INVALID');
    }
    // Um token novo a cada reentrega, e nenhum pedido gravado (nem para M, nem para P).
    expect(new Set(neverIssued).size).toBe(3);
    expect(await t.database.db.select().from(connectionRequests)).toEqual([]);

    // O token do casamento (o hash guardado): o rótulo é ele, sem o `findRecent`, e o pedido vale.
    t.proximity.calls.length = 0;
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: mTokens.bleToken, handle: 'mauro', pairExpiresInS: 55 }),
    ]);
    expect(t.proximity.calls).toEqual(['takeOwedCard', 'hit']);
    await requestConnection(t, v, mTokens.bleToken, 'ble').expect(201);
    expect(
      (await t.database.db.select().from(connectionRequests)).map((row) => [row.fromId, row.toId]),
    ).toEqual([[v.user.id, m.user.id]]);
  });

  it('[PROX-67] [PROX-60] a reentrega acima do limite → 429 (o Retry-After do limite), sem mexer no cartão; com o limite renovado, ainda nos 10 s, o mesmo cartão sai; depois, nada', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const start = now();
    await issueTokens(t, v);
    // 59 relatos no minuto, sem par (a janela do limite abre agora e vai até 60 s).
    for (let index = 0; index < 59; index++) {
      await reportTouch(t, v, [UNKNOWN_TOKEN]).expect(200);
    }
    // 52 s: V relata M (o 60º) e M casa.
    t.clock.advance(52 * SECOND);
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);
    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toHaveLength(1);

    // 53 s: a 1ª entrega não conta no limite.
    t.clock.advance(SECOND);
    const cardOfM = expect.objectContaining({
      token: mTokens.bleToken,
      handle: 'mauro',
    }) as unknown;
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([cardOfM]);
    const marked = valueOf(proximityKeys.owed(v.user.id));

    // 54 s: a reentrega conta (o 61º) → 429, com o Retry-After do limite (6 s); o cartão fica.
    t.clock.advance(SECOND);
    const over = await reportTouch(t, v, [mTokens.bleToken]).expect(429);
    expect(ErrorResponseSchema.parse(over.body).code).toBe('RATE_LIMITED');
    expect(Number(over.headers['retry-after'])).toBe(6);
    expect(valueOf(proximityKeys.owed(v.user.id))).toBe(marked);

    // 60 s: o limite renovou, e ainda faltam 3 s da reentrega: o mesmo cartão (do casamento aos
    // 52 s, faltam 52 s → 50).
    t.clock.advance(start + MINUTE - now());
    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: mTokens.bleToken, handle: 'mauro', pairExpiresInS: 50 }),
    ]);

    // 63 s (10 s depois da 1ª entrega): acabou.
    t.clock.advance(3 * SECOND);
    expect((await reportTouch(t, v, [mTokens.bleToken]).expect(200)).body).toEqual({ items: [] });
    expect(owedKeys()).toEqual([]);
  });

  it('[PROX-67] [PROX-60] a 1ª entrega sai com o limite estourado, a tela fechada e a proximidade bloqueada, tudo junto; a reentrega passa só pelo limite (429 com o Retry-After dele, não o do bloqueio)', async () => {
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);
    // 60 relatos no minuto (1 + 59), e M casa.
    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    for (let index = 0; index < 59; index++) {
      await reportTouch(t, v, [UNKNOWN_TOKEN]).expect(200);
    }
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toHaveLength(1);
    await t.proximity.lock(v.user.id, 15 * MINUTE);
    // 31 s: a tela de V fechou.
    t.clock.advance(31 * SECOND);
    expect(await t.proximity.isScreenOpen(v.user.id)).toBe(false);

    expect(touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ token: mTokens.bleToken, handle: 'mauro', pairExpiresInS: 25 }),
    ]);
    const over = await reportTouch(t, v, [mTokens.bleToken]).expect(429);
    expect(ErrorResponseSchema.parse(over.body).code).toBe('RATE_LIMITED');
    // O limite do minuto (faltam 29 s), não o bloqueio de 15 min.
    expect(Number(over.headers['retry-after'])).toBe(29);
    expect(valueOf(proximityKeys.owed(v.user.id))).toMatch(/^!/);
  });

  it('[PROX-67] [PROX-53] o cartão que chega com menos de 10 s de vida não ganha prazo: vence com o par, e o ocupado dura os 10 s (V chama → busy, byte a byte igual a não mútuo); depois, casa', async () => {
    const reference = await notMutual();
    const v = await person(t, 'vera');
    const m = await person(t, 'mauro');
    const x = await person(t, 'xavier');
    const y = await person(t, 'yara');
    const vTokens = await issueTokens(t, v);
    const mTokens = await issueTokens(t, m);
    await reportTouch(t, v, [mTokens.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200))).toHaveLength(1);
    const marriedAt = now();

    // V volta à tela aos 56 s e recebe o cartão (faltam 4 s → 0).
    t.clock.advance(56 * SECOND);
    const vNow = await issueTokens(t, v);
    expect(touchItems(await reportTouch(t, v, [UNKNOWN_TOKEN]).expect(200))).toEqual([
      expect.objectContaining({ handle: 'mauro', pairExpiresInS: 0 }),
    ]);
    // 59,999 s: a reentrega ainda sai; 60 s: o cartão venceu com o par (não ganhou 10 s).
    t.clock.advance(marriedAt + PAIR_MS - 1 - now());
    expect(touchItems(await reportTouch(t, v, [UNKNOWN_TOKEN]).expect(200))).toHaveLength(1);
    t.clock.advance(1);
    expect(owedKeys()).toEqual([]);
    expect(await hasPair(v, m)).toBe(false);

    // O ocupado vai até 10 s depois da entrega (66 s): X relata V, e V chama X → busy.
    const xTokens = await issueTokens(t, x);
    await reportTouch(t, x, [vNow.bleToken]).expect(200);
    expectSameAs(await reportTouch(t, v, [xTokens.bleToken]).expect(200), reference, 'V chama');
    expect(t.proximity.claims.at(-1)).toBe('busy');

    // 66 s: o ocupado acabou, e V casa com Y (com X, a janela de 5 s já passou).
    t.clock.advance(marriedAt + 66 * SECOND - now());
    const vLater = await issueTokens(t, v);
    const yTokens = await issueTokens(t, y);
    await reportTouch(t, y, [vLater.bleToken]).expect(200);
    expect(touchItems(await reportTouch(t, v, [yTokens.bleToken]).expect(200))).toEqual([
      expect.objectContaining({ handle: 'yara' }),
    ]);
    expect(t.proximity.claims.at(-1)).toBe('created');
  });
});

describe('teto do pairExpiresInS (ADR 0012, A3-5)', () => {
  it('[PROX-64] [PROX-67] com o relógio da instância que entrega atrás do da que casou (1 ms, 3 s ou 9,999 s), o cartão devido e a reentrega dizem 55, nunca 60', async () => {
    for (const behindMs of [1, 3 * SECOND, 2 * WINDOW_MS - 1]) {
      const v = await person(t);
      const m = await person(t);
      const vTokens = await issueTokens(t, v);
      const mTokens = await issueTokens(t, m);
      await reportTouch(t, v, [mTokens.bleToken]).expect(200);
      const [onTime] = touchItems(await reportTouch(t, m, [vTokens.bleToken]).expect(200));
      expect(onTime!.pairExpiresInS).toBe(55);
      // A outra instância: o mesmo Valkey, o relógio atrasado.
      t.clock.advance(-behindMs);
      for (const label of ['1ª entrega', 'reentrega']) {
        const [owed] = touchItems(await reportTouch(t, v, [mTokens.bleToken]).expect(200));
        expect({ behindMs, label, pairExpiresInS: owed!.pairExpiresInS }).toEqual({
          behindMs,
          label,
          pairExpiresInS: 55,
        });
      }
      t.clock.advance(behindMs + PAIR_MS);
    }
  });
});

describe('findTouchPair: as duas contas do encosto, com os fatos em colunas (ADR 0012, A3-1; BAIXO 1 do seguranca)', () => {
  type Facts = Pick<TouchPairRow, 'personal' | 'active' | 'connected' | 'blocked'>;
  const FACTS = ['personal', 'active', 'connected', 'blocked'] as const;
  const FREE: Facts = { personal: true, active: true, connected: false, blocked: false };

  /** O repositório de produção do app (o mesmo SQL), contra o banco do teste. */
  function repository(): ProximityRepository {
    return t.app.get(ProximityRepository);
  }

  function rowOf(user: UserRow, facts: Partial<Facts> = {}): TouchPairRow {
    return {
      id: user.id,
      handle: user.handle,
      name: user.name,
      avatarKey: user.avatarKey,
      ...FREE,
      ...facts,
    };
  }

  /**
   * `findTouchPair` nas duas ordens (quem chama e o dono trocados, para o `least`/`greatest` ver os
   * ids nas duas ordens): as mesmas linhas, conferidas pelo id (o banco não promete ordem), com os
   * quatro fatos como `boolean` de JS (nem `1`, nem `'t'`).
   */
  async function expectPair(
    label: string,
    first: UserRow,
    second: UserRow,
    expected: TouchPairRow[],
  ): Promise<void> {
    for (const [viewer, owner] of [
      [first, second],
      [second, first],
    ] as const) {
      const rows = await repository().findTouchPair(viewer.id, owner.id);
      const where = `${label}, chamado por ${viewer.handle}`;
      for (const row of rows) {
        for (const fact of FACTS) {
          expect(typeof row[fact], `${where}: ${fact} de ${row.handle}`).toBe('boolean');
        }
      }
      expect({ where, rows: [...rows].sort(byId) }).toEqual({
        where,
        rows: [...expected].sort(byId),
      });
    }
  }

  /** Quatro contas pessoais, em ordem crescente de id. */
  async function fourSorted(): Promise<Person[]> {
    const people: Person[] = [];
    for (let index = 0; index < 4; index++) {
      people.push(await person(t));
    }
    return people.sort((first, second) => byId(first.user, second.user));
  }

  it('[PROX-66] [PROX-36] sem relação entre as duas: as duas linhas, pessoais, ativas, sem conexão nem bloqueio, nas duas ordens; as conexões e os bloqueios de cada uma com terceiras (cada sentido, cada lado do par ordenado) não contam', async () => {
    // u1 < u2 < u3 < u4; o par é u2–u3 (least = u2, greatest = u3).
    const [u1, u2, u3, u4] = (await fourSorted()).map((who) => who.user) as [
      UserRow,
      UserRow,
      UserRow,
      UserRow,
    ];
    // Conexão com o mesmo `user_a_id` (u2–u4) e com o mesmo `user_b_id` (u1–u3) do par.
    await connect(t.database.db, u2, u4);
    await connect(t.database.db, u1, u3);
    // Cada uma bloqueia uma terceira e é bloqueada por outra.
    await block(t.database.db, u2, u1);
    await block(t.database.db, u4, u2);
    await block(t.database.db, u3, u4);
    await block(t.database.db, u1, u3);

    await expectPair('sem relação', u2, u3, [rowOf(u2), rowOf(u3)]);
  });

  it('[PROX-66] conexão: connected = true nas duas linhas, nas duas ordens dos ids (o par ordenado do banco é achado qualquer que seja quem chama)', async () => {
    const v = await person(t);
    const o = await person(t);
    await connect(t.database.db, v.user, o.user);
    await expectPair('conexão', v.user, o.user, [
      rowOf(v.user, { connected: true }),
      rowOf(o.user, { connected: true }),
    ]);
  });

  it('[PROX-66] [PROX-36] [X.2] bloqueio: V bloqueou O, O bloqueou V e os dois sentidos → blocked = true nas duas linhas e nas duas ordens, com as duas linhas de volta (pessoais e ativas); desbloqueado pela rota (DELETE /me/blocks/:handle) → false (nos dois sentidos, só depois do segundo desbloqueio)', async () => {
    for (const direction of ['V bloqueou O', 'O bloqueou V', 'os dois sentidos'] as const) {
      const v = await person(t);
      const o = await person(t);
      const blockers: [Person, Person][] =
        direction === 'V bloqueou O'
          ? [[v, o]]
          : direction === 'O bloqueou V'
            ? [[o, v]]
            : [
                [v, o],
                [o, v],
              ];
      for (const [blocker, blocked] of blockers) {
        await block(t.database.db, blocker.user, blocked.user);
      }
      await expectPair(direction, v.user, o.user, [
        rowOf(v.user, { blocked: true }),
        rowOf(o.user, { blocked: true }),
      ]);

      for (const [index, [blocker, blocked]] of blockers.entries()) {
        await t.http
          .delete(`/v1/me/blocks/${blocked.user.handle}`)
          .set(blocker.headers)
          .expect(204);
        const still = index < blockers.length - 1;
        await expectPair(`${direction}, ${String(index + 1)}º desbloqueio`, v.user, o.user, [
          rowOf(v.user, { blocked: still }),
          rowOf(o.user, { blocked: still }),
        ]);
      }
    }
  });

  it('[PROX-66] [PROX-36] o WHERE só filtra pelos ids: O excluída (active = false só na linha de O), O criadora (personal = false só na linha de O) e O excluída e bloqueada por V → as duas linhas, nas duas ordens; O apagada de vez → só a linha de V', async () => {
    const v = await person(t);
    const deleted = await person(t);
    const creator = await createUser(t.database.db, { accountType: 'creator' });
    const deletedAndBlocked = await person(t);
    const gone = await person(t);
    await t.database.db
      .update(users)
      .set({ deletedAt: t.clock.now() })
      .where(inArray(users.id, [deleted.user.id, deletedAndBlocked.user.id]));
    await block(t.database.db, v.user, deletedAndBlocked.user);
    await t.database.db.delete(users).where(eq(users.id, gone.user.id));

    await expectPair('O excluída', v.user, deleted.user, [
      rowOf(v.user),
      rowOf(deleted.user, { active: false }),
    ]);
    await expectPair('O criadora', v.user, creator, [
      rowOf(v.user),
      rowOf(creator, { personal: false }),
    ]);
    await expectPair('O excluída e bloqueada por V', v.user, deletedAndBlocked.user, [
      rowOf(v.user, { blocked: true }),
      rowOf(deletedAndBlocked.user, { active: false, blocked: true }),
    ]);
    await expectPair('O apagada de vez', v.user, gone.user, [rowOf(v.user)]);
  });

  it('[PROX-66] (R22) o mesmo plano com e sem bloqueio: no EXPLAIN ANALYZE do SQL que o findTouchPair mandou ao banco, a conexão e os dois sentidos do bloqueio rodam uma vez cada (nenhum "never executed"), inclusive quando o primeiro sentido já achou o bloqueio (a soma, não o or); só mudam os ids e as contagens', async () => {
    interface SqlClient {
      query(
        query: string | { text: string; values?: unknown[] },
        params?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }>;
    }
    const client = (t.database.db as unknown as { $client: SqlClient }).$client;

    /** O plano executado do SQL (e dos parâmetros) que o `findTouchPair` mandou, sem números. */
    async function plan(viewer: UserRow, owner: UserRow): Promise<string> {
      const sent = vi.spyOn(client, 'query');
      let query: string | { text: string; values?: unknown[] };
      let params: unknown[] | undefined;
      try {
        await repository().findTouchPair(viewer.id, owner.id);
        expect(sent).toHaveBeenCalledTimes(1);
        [query, params] = sent.mock.calls[0]!;
      } finally {
        sent.mockRestore();
      }
      // PGlite: `query(sql, params, opções)`; node-postgres (CI): `query({text, …}, params)`.
      const text = typeof query === 'string' ? query : query.text;
      const values = typeof query === 'string' ? params : (query.values ?? params);
      const explained = await client.query(
        `explain (analyze, costs off, timing off, summary off, buffers off) ${text}`,
        values,
      );
      return explained.rows
        .map((row) => String(Object.values(row)[0]))
        .join('\n')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
        .replace(/\d+(\.\d+)?/g, '<n>');
    }

    // Todas as contas e bloqueios antes dos planos: o planejador vê as mesmas tabelas nos quatro.
    const pairs: [string, Person, Person][] = [];
    for (const name of ['sem bloqueio', 'V bloqueou O', 'O bloqueou V', 'os dois sentidos']) {
      pairs.push([name, await person(t), await person(t)]);
    }
    await block(t.database.db, pairs[1]![1].user, pairs[1]![2].user);
    await block(t.database.db, pairs[2]![2].user, pairs[2]![1].user);
    await block(t.database.db, pairs[3]![1].user, pairs[3]![2].user);
    await block(t.database.db, pairs[3]![2].user, pairs[3]![1].user);

    const plans: { name: string; plan: string }[] = [];
    for (const [name, v, o] of pairs) {
      plans.push({ name, plan: await plan(v.user, o.user) });
    }
    const [reference] = plans;
    for (const { name, plan: text } of plans) {
      expect({ name, neverExecuted: text.includes('never executed') }).toEqual({
        name,
        neverExecuted: false,
      });
      expect({ name, blocks: text.match(/ on blocks\b/g)?.length }).toEqual({ name, blocks: 2 });
      expect({ name, connections: text.match(/ on connections\b/g)?.length }).toEqual({
        name,
        connections: 1,
      });
      expect({ name, plan: text }).toEqual({ name, plan: reference!.plan });
    }
  });
});
