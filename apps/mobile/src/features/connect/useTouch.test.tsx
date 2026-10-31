import {
  PROXIMITY_TOUCH_LIMIT_PER_MIN,
  PROXIMITY_TOUCH_REPORT_FOR_S,
  PROXIMITY_TOUCH_WINDOW_S,
} from '@sussurro/shared';
import { act, renderHook } from '@testing-library/react-native';

import { connectTiming } from './timing';
import { cardExpiresAt, cardTtlMs, TOUCH_CALIBRATION } from './touch-calibration';
import type { TouchReceiver } from './touch-detector';
import { resetTouchReportGate, type TouchPhase, useTouch } from './useTouch';
import {
  createFakeRadio,
  type FakeRadio,
} from '../../../modules/sussurro-proximity/src/fake-radio';
import { ApiClient } from '../../lib/api/client';
import { ApiError } from '../../lib/api/errors';
import { createMemorySessionStore } from '../../lib/session/secure-session-store';
import {
  apiError,
  mutualTouches,
  nearbyPerson,
  touchItem,
} from '../../test-utils/connect-fixtures';
import {
  BASE_URL,
  createFakeApi,
  type FakeApi,
  type FakeCall,
  type FakeReply,
} from '../../test-utils/fake-api';

const CAIO = 'CaioTokenBBBBBB1';
const BIA = 'BiaTokenCCCCCCC1';
const LUCAS = 'LucasBleTokenFF1';
const TM = 'MarcosTokenAAAA1';
const TM2 = 'MarcosTokenAAAA2';
const TX = 'XavierTokenBBBB1';
const TY = 'YaraTokenCCCCCC1';
const REAL = 'RealPessoaToken1';
const TOUCH_LOSS = 30;
const NEAR_LOSS = 48;
const CAL = TOUCH_CALIBRATION;
/** A referência única de todo emissor (adendo A1): RSSI = referência − perda. */
const TX_REF = CAL.advertiserTxDbm;
const EMPTY: FakeReply = { status: 200, body: { items: [] } };
const MINUTE = 60_000;

type Handler = FakeReply | ((call: FakeCall) => FakeReply | Promise<FakeReply>);

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** Anúncios a cada 200 ms durante `ms`, com a perda pedida por token. */
async function sight(radio: FakeRadio, ms: number, seen: { token: string; loss: number }[]) {
  for (let elapsed = 0; elapsed < ms; elapsed += CAL.sightingMinIntervalMs) {
    await act(async () => {
      for (const { token, loss } of seen) radio.emitSighting(token, TX_REF - loss);
      await jest.advanceTimersByTimeAsync(CAL.sightingMinIntervalMs);
    });
  }
}

/** Encosta: ~1,2 s com perda de encosto (3 amostras + 0,7 s sustentado) e 0,2 s a mais. */
async function touch(radio: FakeRadio, token = CAIO, loss = TOUCH_LOSS) {
  await sight(radio, 1400, [{ token, loss }]);
}

/**
 * Vários tokens, cada um anunciado a cada 200 ms a partir do próprio `from` (até `to`), num relógio
 * de passo de 25 ms: dá para encostar vários tokens com poucos ms de diferença.
 */
async function sightEach(
  radio: FakeRadio,
  plan: { token: string; loss: number; from: number; to: number }[],
  ms: number,
) {
  const step = 25;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await act(async () => {
      for (const { token, loss, from, to } of plan) {
        if (elapsed >= from && elapsed < to && (elapsed - from) % CAL.sightingMinIntervalMs === 0) {
          radio.emitSighting(token, TX_REF - loss);
        }
      }
      await jest.advanceTimersByTimeAsync(step);
    });
  }
}

/** Resposta depois de `ms` (relógio falso). */
function later(ms: number, reply: FakeReply = EMPTY): Promise<FakeReply> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(reply);
    }, ms);
  });
}

/**
 * Servidor falso do `touches` que anota cada relato (início e token), quantos ficaram em voo ao
 * mesmo tempo e se algum passaria do limite do servidor (60 por minuto → 429).
 */
function touchServer(
  reply: (token: string, index: number) => FakeReply | Promise<FakeReply> = () => EMPTY,
) {
  const sent: { at: number; token: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let limited = 0;
  const handler = async ({ body }: FakeCall): Promise<FakeReply> => {
    const [token = ''] = (body as { tokens: string[] }).tokens;
    const at = Date.now();
    sent.push({ at, token });
    if (sent.filter((call) => call.at > at - MINUTE).length > PROXIMITY_TOUCH_LIMIT_PER_MIN) {
      limited += 1;
      return apiError(429, 'RATE_LIMITED');
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await reply(token, sent.length - 1);
    } finally {
      inFlight -= 1;
    }
  };
  return {
    handler,
    sent,
    starts: () => sent.map((call) => call.at),
    maxInFlight: () => maxInFlight,
    limited: () => limited,
  };
}

/** O maior número de inícios em qualquer janela de 60 s. */
function maxPerMinute(starts: readonly number[]): number {
  return Math.max(
    0,
    ...starts.map((end) => starts.filter((at) => at > end - MINUTE && at <= end).length),
  );
}

/** Intervalos entre inícios seguidos. */
function gaps(starts: readonly number[]): number[] {
  return starts.slice(1).map((at, index) => at - (starts[index] ?? at));
}

async function setup(
  options: {
    listening?: boolean;
    platform?: TouchReceiver['platform'];
    touches?: Handler;
    api?: FakeApi;
    radio?: FakeRadio;
  } = {},
) {
  const api = options.api ?? createFakeApi();
  if (options.api === undefined || options.touches !== undefined) {
    api.on('POST /v1/proximity/touches', options.touches ?? EMPTY);
  }
  const radio = options.radio ?? createFakeRadio();
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: api.fetch,
    tokens: createMemorySessionStore({}),
  });
  const receiver: TouchReceiver = { platform: options.platform ?? 'ios', model: 'Teste' };
  const onCard = jest.fn();
  const onReportError = jest.fn();
  const onScanError = jest.fn();
  const refreshScreen = jest.fn(() => Promise.resolve());
  const hook = await renderHook(
    (props: { listening: boolean; scanning: boolean }) =>
      useTouch({
        api: http,
        radio,
        receiver,
        scanning: props.scanning,
        listening: props.listening,
        onCard,
        onReportError,
        onScanError,
        refreshScreen,
      }),
    { initialProps: { listening: options.listening ?? true, scanning: true } },
  );
  await advance(0);
  const reports = () => api.callsTo('POST /v1/proximity/touches');
  const reported = () => reports().map((call) => (call.body as { tokens: string[] }).tokens);
  return {
    ...hook,
    api,
    radio,
    onCard,
    onReportError,
    onScanError,
    refreshScreen,
    reports,
    reported,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-30T12:00:00.000Z') });
  // O ritmo e o orçamento ficam no módulo (R1-3): cada teste começa do zero.
  resetTouchReportGate();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useTouch: relato do encosto (ADR 0012 §2)', () => {
  it('PROX-43: relata só {tokens:[bleToken]} (sem RSSI, potência nem modelo), a cada 1 s, por 8 s, mesmo depois de afastar', async () => {
    const { radio, reports, reported, result } = await setup();
    expect(radio.scanning).toBe(true);
    await touch(radio);
    expect(result.current.phase).toBe('confirming');
    expect(reports()).toHaveLength(1);

    // Os celulares se afastam: o relato continua até os 8 s (a revelação é simétrica).
    await advance(12_000);
    expect(reports()).toHaveLength(8);
    expect(reported()).toEqual(Array.from({ length: 8 }, () => [CAIO]));
    for (const call of reports()) {
      expect(Object.keys(call.body as object)).toEqual(['tokens']);
      expect(JSON.stringify(call.body)).not.toMatch(/rssi|tx|power|model|loss|-\d/i);
    }
  });

  it('sem sobrepor chamadas: com o servidor lento, a próxima só sai depois que a anterior volta', async () => {
    const server = touchServer(() => later(1500));
    const { radio } = await setup({ touches: server.handler });
    await touch(radio);
    await advance(12_000);
    expect(server.maxInFlight()).toBe(1);
    // A 1ª resposta chega aos 1,5 s, e o relato vai até 8 s depois dela (R1-2):
    // 0; 1,5; 3; 4,5; 6; 7,5; 9 s.
    expect(server.sent).toHaveLength(7);
  });

  it('para de relatar quando o cartão chega (items[0]); o cartão vale 55 s', async () => {
    const caio = nearbyPerson({ token: CAIO });
    const { radio, reports, onCard, result } = await setup({
      touches: mutualTouches({ [CAIO]: caio }),
    });
    await touch(radio);
    // O 1º relato volta vazio (o outro ainda não relatou); o 2º, 1 s depois, traz o cartão.
    await advance(1000);
    expect(reports()).toHaveLength(2);
    expect(onCard).toHaveBeenCalledTimes(1);
    const [card] = onCard.mock.calls[0] as [
      { person: unknown; matchedAt: number; expiresAt: number },
    ];
    // O `pairExpiresInS` serve só ao prazo: o cartão guarda a pessoa.
    expect(card.person).toEqual(caio);
    expect(card.expiresAt - card.matchedAt).toBe(55_000);

    // Ainda encostados e o tempo passa: nada mais é relatado.
    await sight(radio, 3000, [{ token: CAIO, loss: TOUCH_LOSS }]);
    await advance(10_000);
    expect(reports()).toHaveLength(2);
    expect(result.current.phase).not.toBe('confirming');
  });

  it('P3: o casamento depois do aviso dos 4 s ainda abre o cartão (9 → 11)', async () => {
    let calls = 0;
    const caio = touchItem(nearbyPerson({ token: CAIO }));
    const { radio, onCard, result } = await setup({
      touches: () => {
        calls += 1;
        return { status: 200, body: { items: calls >= 6 ? [caio] : [] } };
      },
    });
    await touch(radio);
    await advance(4200);
    expect(result.current.phase).toBe('notConfirmed');
    expect(onCard).not.toHaveBeenCalled();
    await advance(1000);
    expect(onCard).toHaveBeenCalledTimes(1);
  });

  it('P8: sem cartão, só o token encostado de menor perda; fora do Pronto (cartão na tela), nada', async () => {
    const { radio, reported, reports, rerender } = await setup({ listening: false });
    // Fora do Pronto: encostar não relata.
    await sight(radio, 2000, [{ token: CAIO, loss: TOUCH_LOSS }]);
    expect(reports()).toHaveLength(0);
    // De volta ao Pronto ainda encostados: precisa encostar de novo (afastar e encostar).
    await rerender({ listening: true, scanning: true });
    await advance(1000);
    expect(reports()).toHaveLength(0);
    await advance(2000);
    // Dois celulares encostados ao mesmo tempo: vai só o de menor perda (Bia).
    await sight(radio, 1400, [
      { token: CAIO, loss: 38 },
      { token: BIA, loss: 31 },
    ]);
    expect(reported()).toEqual([[BIA]]);
  });
});

describe('useTouch: PROX-64, o prazo do cartão vem do par no servidor (pairExpiresInS)', () => {
  it('PROX-64: expiresAt = chegada + min(55 s, pairExpiresInS × 1000), sem descontar a margem de novo', () => {
    // O servidor já arredonda para baixo em múltiplos de 5 s: 55 no casamento na hora.
    expect(cardTtlMs()).toBe(55_000);
    expect(cardExpiresAt(1000, 55)).toBe(1000 + 55_000);
    expect(cardExpiresAt(1000, 60)).toBe(1000 + cardTtlMs());
    expect(cardExpiresAt(1000, 10)).toBe(1000 + 10_000);
    expect(cardExpiresAt(1000, 0)).toBe(1000);
  });

  it('PROX-64: o cartão devido que chega tarde (pairExpiresInS = 10) vence aos 10 s, e não 55 s depois da chegada', async () => {
    const late = touchItem(nearbyPerson({ token: CAIO }), 10);
    const { radio, onCard } = await setup({ touches: mutualTouches({ [CAIO]: late }) });
    await touch(radio);
    await advance(1000);
    expect(onCard).toHaveBeenCalledTimes(1);
    const [card] = onCard.mock.calls[0] as [{ matchedAt: number; expiresAt: number }];
    expect(card.expiresAt - card.matchedAt).toBe(10_000);
  });
});

describe('useTouch: PROX-57, token novo e prazo que só cresce (ADR 0012, A2 rev. 1, R1-3)', () => {
  it('PROX-57: reportForMs vem do contrato (8 s) e cobre a janela do casamento + 2 s de latência', () => {
    expect(CAL.reportForMs).toBe(PROXIMITY_TOUCH_REPORT_FOR_S * 1000);
    expect(CAL.reportForMs).toBeGreaterThanOrEqual((PROXIMITY_TOUCH_WINDOW_S + 2) * 1000);
  });

  it('PROX-57: o 1º relato responde em 3 s → o relato vai até 8 s depois da resposta; o aviso dos 4 s não muda', async () => {
    const server = touchServer((_token, index) => (index === 0 ? later(3000) : EMPTY));
    const { radio, result } = await setup({ touches: server.handler });
    await touch(radio);
    const [touchedAt = 0] = server.starts();
    // O aviso continua contado do encosto.
    await advance(touchedAt + CAL.confirmWarnAfterMs - 200 - Date.now());
    expect(result.current.phase).toBe('confirming');
    await advance(400);
    expect(result.current.phase).toBe('notConfirmed');

    await advance(20_000);
    // Resposta aos 3 s: relatos até 3 + 8 s.
    expect(server.starts().map((at) => at - touchedAt)).toEqual([
      0, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000,
    ]);
  });

  it('PROX-57 (A): tM encostado em 0 e de novo em 3 s (aceito há 1 s, não é novo) → prazo até 11 s, relatos a 1/s até lá, um laço só', async () => {
    const server = touchServer();
    const { radio } = await setup({ touches: server.handler });
    await touch(radio, TM);
    // Afastam (a janela da mediana esvazia) e encostam de novo: "encostado" outra vez aos 3 s.
    await advance(1600);
    await touch(radio, TM);
    await advance(20_000);
    const [first = 0] = server.starts();
    expect(server.starts().map((at) => at - first)).toEqual([
      0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000,
    ]);
    expect(server.sent.every((call) => call.token === TM)).toBe(true);
    expect(server.maxInFlight()).toBe(1);
  });

  it('PROX-57 (A): tM2 (outro token) encostado aos 3 s é novo → o prazo vai a resposta + 8 s', async () => {
    const server = touchServer((token) =>
      token === TM2 && server.sent.filter((call) => call.token === TM2).length === 1
        ? later(1500)
        : EMPTY,
    );
    const { radio } = await setup({ touches: server.handler });
    await touch(radio, TM);
    await advance(1400);
    // tM2 fica "encostado" pouco antes dos 3 s; o 1º relato dele (aos 3 s) responde em 1,5 s.
    await touch(radio, TM2);
    await advance(20_000);
    const [first = 0] = server.starts();
    const firstTm2 = server.sent.find((call) => call.token === TM2)?.at ?? 0;
    expect(firstTm2 - first).toBe(3000);
    const last = server.sent.at(-1)?.at ?? 0;
    // Prazo = resposta (4,5 s) + 8 s = 12,5 s: o último relato começa aos 11,5 s.
    expect(last - first).toBe(11_500);
    expect(last - (firstTm2 + 1500)).toBeGreaterThanOrEqual(CAL.reportForMs - CAL.reportEveryMs);
  });

  it('PROX-57 (B): tM em 0, tX em 1 s, tY em 9 s e tM de novo em 15 s → tM conta como novo e o relato vai até a resposta dele + 8 s', async () => {
    // O relato de tM aos 15 s responde em 2 s: o prazo vai a 17 + 8 = 25 s (só o encosto daria 23).
    let slowed = false;
    const server = touchServer((token) => {
      const first = server.sent[0]?.at ?? 0;
      if (token !== TM || slowed || Date.now() - first < 10_000) return EMPTY;
      slowed = true;
      return later(2000);
    });
    const { radio } = await setup({ touches: server.handler });
    // tX fica "encostado" pouco antes de 1 s (com perda menor, vira o mais forte).
    await sightEach(
      radio,
      [
        { token: TM, loss: TOUCH_LOSS, from: 0, to: 1400 },
        { token: TX, loss: 25, from: 800, to: 2200 },
      ],
      2200,
    );
    const [first = 0] = server.starts();
    // tY: "encostado" aos 9 s (os anúncios começam 1,2 s antes).
    await advance(first + 7800 - Date.now());
    await touch(radio, TY);
    // tM de novo, mais forte: "encostado" pouco antes dos 15 s.
    await advance(first + 13_600 - Date.now());
    await touch(radio, TM, 20);
    await advance(20_000);

    const at = (token: string) =>
      server.sent.filter((call) => call.token === token).map((call) => call.at - first);
    expect(at(TX)[0]).toBe(1000);
    expect(at(TY)[0]).toBe(9000);
    // tM: aceito em 0 e de novo aos 15 s (aceito há 15 s, conta como novo).
    expect(at(TM)[0]).toBe(0);
    expect(at(TM)[1]).toBe(15_000);
    const last = (server.sent.at(-1)?.at ?? 0) - first;
    expect(last).toBe(24_000);
    // O prazo nunca desce: entre os 15 s e o fim, o relato não para.
    expect(gaps(at(TM).slice(1))).toEqual([2000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
  });

  it('PROX-57: um token novo no mesmo encosto estende o relato até 8 s depois da resposta do 1º relato dele', async () => {
    const server = touchServer();
    const { radio } = await setup({ touches: server.handler });
    // Caio e Bia encostam juntos: vai o de menor perda, Caio (P8).
    await sight(radio, 4000, [
      { token: CAIO, loss: TOUCH_LOSS },
      { token: BIA, loss: 38 },
    ]);
    // Bia passa a ter a menor perda (e continuam encostados): o relato troca para o token dela.
    await sight(radio, 12_000, [
      { token: CAIO, loss: 38 },
      { token: BIA, loss: 20 },
    ]);
    await advance(20_000);

    const { sent } = server;
    const touchedAt = sent[0]?.at ?? 0;
    const firstBiaAt = sent.find((call) => call.token === BIA)?.at ?? -1;
    const last = sent.at(-1);
    expect(sent[0]?.token).toBe(CAIO);
    expect(firstBiaAt).toBeGreaterThan(touchedAt);
    expect(firstBiaAt - touchedAt).toBeLessThan(CAL.reportForMs);
    expect(sent.filter((call) => call.at >= firstBiaAt).every((call) => call.token === BIA)).toBe(
      true,
    );
    // O último relato sai 7 s depois do 1º de Bia (resposta na hora): além dos 8 s do encosto.
    expect(last?.token).toBe(BIA);
    expect((last?.at ?? 0) - firstBiaAt).toBe(CAL.reportForMs - CAL.reportEveryMs);
    expect((last?.at ?? 0) - touchedAt).toBeGreaterThanOrEqual(CAL.reportForMs);
  });

  it('P8 / PROX-57: Caio → Bia → afastam: o relato continua com Bia (o último relatado), sem voltar a Caio', async () => {
    const server = touchServer();
    const { radio } = await setup({ touches: server.handler });
    await sight(radio, 4000, [
      { token: CAIO, loss: TOUCH_LOSS },
      { token: BIA, loss: 38 },
    ]);
    await sight(radio, 2000, [
      { token: CAIO, loss: 38 },
      { token: BIA, loss: 20 },
    ]);
    // Afastam: a janela da mediana esvazia e nenhum encostado tem mediana.
    const separatedAt = Date.now();
    await advance(20_000);

    const firstBiaAt = server.sent.find((call) => call.token === BIA)?.at ?? Infinity;
    expect(firstBiaAt).toBeLessThan(separatedAt);
    const afterBia = server.sent.filter((call) => call.at >= firstBiaAt);
    expect(afterBia.some((call) => call.at > separatedAt + CAL.windowMs)).toBe(true);
    expect(afterBia.map((call) => call.token)).toEqual(afterBia.map(() => BIA));
  });

  it('PROX-57: o 409 (tela fechada) não conta como aceito; o prazo conta da 1ª resposta aceita do token', async () => {
    const server = touchServer((_token, index) =>
      index === 0 ? apiError(409, 'PROXIMITY_SCREEN_CLOSED') : EMPTY,
    );
    const { radio, refreshScreen } = await setup({ touches: server.handler });
    await touch(radio);
    await advance(20_000);
    expect(refreshScreen).toHaveBeenCalledTimes(1);
    const [touchedAt = 0] = server.starts();
    // O 409 não gravou nada no servidor: a 1ª resposta aceita (1 s) abre o prazo, até 9 s.
    expect(server.starts().map((at) => at - touchedAt)).toEqual([
      0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000,
    ]);
  });

  it('PROX-57: voltar ao Pronto zera o mapa de tokens aceitos (só estende): tM relatado de novo 3 s depois conta como novo', async () => {
    // O 1º relato de tM depois da volta responde em 1,5 s.
    let slowNext = false;
    const server = touchServer(() => {
      if (!slowNext) return EMPTY;
      slowNext = false;
      return later(1500);
    });
    const { radio, rerender } = await setup({ touches: server.handler });
    await touch(radio, TM);
    const [first = 0] = server.starts();
    await advance(1000);
    // Sai do Pronto (cartão de outra pessoa, QR…) e volta.
    await rerender({ listening: false, scanning: true });
    await rerender({ listening: true, scanning: true });
    slowNext = true;
    await advance(first + 2800 - Date.now());
    await touch(radio, TM);
    await advance(20_000);
    const afterBack = server.starts().filter((at) => at - first >= 4000);
    expect(afterBack[0]! - first).toBe(4000);
    // Novo de novo: prazo = resposta (5,5 s) + 8 s = 13,5 s; o último relato começa aos 13,5 − 1.
    expect(afterBack.at(-1)! - first).toBe(12_500);
  });
});

describe('useTouch: PROX-58, um relato por vez no processo (variante C)', () => {
  it('PROX-58: 5 tokens novos encostados em 300 ms → um relato em voo, inícios a ≥ 1 s; com a resposta em 2 s, nunca dois em voo', async () => {
    const server = touchServer(() => later(2000));
    const { radio, result } = await setup({ touches: server.handler });
    const tokens = ['Novo0TokenAAAAA1', 'Novo1TokenAAAAA1', 'Novo2TokenAAAAA1', 'Novo3TokenAAAAA1'];
    await sightEach(
      radio,
      [CAIO, ...tokens].map((token, index) => ({
        token,
        // Cada um mais forte que o anterior: o token do relato troca a cada encosto.
        loss: TOUCH_LOSS - index,
        from: index * 75,
        to: index * 75 + 1400,
      })),
      1800,
    );
    expect(result.current.phase).toBe('confirming');
    await advance(20_000);
    expect(server.maxInFlight()).toBe(1);
    expect(gaps(server.starts()).every((gap) => gap >= CAL.reportEveryMs)).toBe(true);
    // Um relato só saiu nos primeiros 2 s (o 1º), e não um por encosto.
    const [first = 0] = server.starts();
    expect(server.starts().filter((at) => at < first + 2000)).toHaveLength(1);
  });

  it('PROX-58: sair e voltar ao Pronto com um relato em voo não fura o ritmo; a resposta que chega fora do Pronto libera o próximo', async () => {
    const server = touchServer((_token, index) => (index === 0 ? later(2500) : EMPTY));
    const { radio, rerender, result } = await setup({ touches: server.handler });
    await touch(radio, CAIO);
    const [first = 0] = server.starts();
    // Sai do Pronto e volta com o relato em voo; um encosto novo (simulado) logo depois.
    await advance(300);
    await rerender({ listening: false, scanning: true });
    await advance(200);
    await rerender({ listening: true, scanning: true });
    await act(async () => {
      result.current.simulate(LUCAS);
      await Promise.resolve();
    });
    await advance(10_000);
    // O 2º relato espera a resposta do 1º (2,5 s), mesmo depois de sair do Pronto, e então sai.
    expect(server.sent[1]?.token).toBe(LUCAS);
    expect((server.sent[1]?.at ?? 0) - first).toBe(2500);
    expect(server.maxInFlight()).toBe(1);
    expect(gaps(server.starts()).every((gap) => gap >= CAL.reportEveryMs)).toBe(true);
  });

  it('PROX-58: desmontar e montar a tela com um relato em voo não fura o ritmo (o estado fica no módulo)', async () => {
    const server = touchServer((_token, index) => (index === 0 ? later(1800) : EMPTY));
    const api = createFakeApi();
    api.on('POST /v1/proximity/touches', server.handler);
    const before = await setup({ api });
    await touch(before.radio, CAIO);
    const [first = 0] = server.starts();
    await before.unmount();
    // A tela monta de novo (outro motor) e um encosto entra logo.
    const after = await setup({ api });
    await act(async () => {
      after.result.current.simulate(LUCAS);
      await Promise.resolve();
    });
    await advance(10_000);
    expect(server.sent[1]?.token).toBe(LUCAS);
    expect((server.sent[1]?.at ?? 0) - first).toBe(1800);
    expect(server.maxInFlight()).toBe(1);
  });

  it('PROX-58: com a resposta na hora, o encosto novo dentro de 1 s espera o ritmo (≥ 1 s entre inícios)', async () => {
    const server = touchServer();
    const { radio, result } = await setup({ touches: server.handler });
    await touch(radio, CAIO);
    const [first = 0] = server.starts();
    await advance(300);
    await act(async () => {
      result.current.simulate(LUCAS);
      await Promise.resolve();
    });
    await advance(0);
    // O encosto novo não dispara um relato fora do ritmo: troca o token e estende o prazo.
    expect(server.sent).toHaveLength(1);
    await advance(10_000);
    expect(server.sent[1]?.at).toBe(first + 1000);
    expect(server.maxInFlight()).toBe(1);
  });
});

describe('useTouch: PROX-59, orçamento contra transmissor girando UUIDs (BAIXO 5)', () => {
  /** Um UUID novo por anúncio de 200 ms; cada um fica 1,4 s no ar (vira "encostado"). */
  function hostile(index: number): string {
    return `Hostil${String(index).padStart(10, '0')}`;
  }

  /**
   * O transmissor hostil por `ms` (um token novo a cada 200 ms), com outros anúncios por cima.
   * Anota a fase a cada passo.
   */
  async function rotate(
    radio: FakeRadio,
    ms: number,
    phases: { at: number; phase: TouchPhase }[],
    read: () => TouchPhase,
    extra: (elapsed: number) => { token: string; loss: number }[] = () => [],
  ) {
    const step = CAL.sightingMinIntervalMs;
    const live = 1400 / step;
    for (let tick = 0; tick * step < ms; tick += 1) {
      await act(async () => {
        for (let index = Math.max(0, tick - live + 1); index <= tick; index += 1) {
          radio.emitSighting(hostile(index), TX_REF - TOUCH_LOSS);
        }
        for (const { token, loss } of extra(tick * step)) radio.emitSighting(token, TX_REF - loss);
        await jest.advanceTimersByTimeAsync(step);
      });
      const phase = read();
      if (phases.at(-1)?.phase !== phase) phases.push({ at: Date.now(), phase });
    }
  }

  it('PROX-59: orçamento de 40 por minuto (≤ 2/3 do limite do servidor) com reserva de 10 (≥ o que um prazo aberto ainda precisa)', () => {
    expect(CAL.reportBudgetPerMinute).toBe(40);
    expect(CAL.reportReserve).toBe(10);
    expect(CAL.reportBudgetPerMinute).toBeLessThanOrEqual((PROXIMITY_TOUCH_LIMIT_PER_MIN * 2) / 3);
    expect(CAL.reportReserve).toBeGreaterThanOrEqual(
      Math.ceil(CAL.reportForMs / CAL.reportEveryMs) + 1,
    );
  });

  it('PROX-59: um UUID novo encostado a cada 200 ms por 3 min → no máximo 39 inícios em qualquer janela de 60 s, sem 429; todo token novo entra com ≤ 30 inícios antes; o prazo aberto nunca encurta', async () => {
    const server = touchServer();
    const { radio, result, onReportError } = await setup({ touches: server.handler });
    const phases: { at: number; phase: TouchPhase }[] = [];
    await rotate(radio, 3 * MINUTE, phases, () => result.current.phase);
    await advance(20_000);

    const starts = server.starts();
    expect(starts.length).toBeGreaterThan(60);
    expect(maxPerMinute(starts)).toBeLessThanOrEqual(39);
    expect(server.limited()).toBe(0);
    expect(onReportError).not.toHaveBeenCalled();
    expect(server.maxInFlight()).toBe(1);
    expect(gaps(starts).every((gap) => gap >= CAL.reportEveryMs)).toBe(true);

    // O 1º relato de cada token (o token novo) saiu com no máximo 30 inícios nos 60 s anteriores.
    const seen = new Set<string>();
    const firsts: number[] = [];
    for (const { at, token } of server.sent) {
      if (seen.has(token)) continue;
      seen.add(token);
      firsts.push(at);
      expect(
        starts.filter((start) => start > at - MINUTE && start < at).length,
      ).toBeLessThanOrEqual(30);
    }
    // Acima disso, o token novo é ignorado: o relato segue com o último aceito até o fim do prazo
    // (resposta + 8 s), sem encurtar. Depois de cada token novo há relato a pelo menos 7 s dele.
    const repeated = server.sent.filter((call, index) =>
      server.sent.slice(0, index).some((before) => before.token === call.token),
    );
    expect(repeated.length).toBeGreaterThan(0);
    for (const at of firsts) {
      expect(starts.some((start) => start >= at + CAL.reportForMs - CAL.reportEveryMs)).toBe(true);
    }
    // O portão fecha (um buraco de vários segundos) e reabre quando os inícios antigos saem dos
    // 60 s: há relatos de tokens novos depois do buraco.
    const holeEnd = starts.find((at, index) => index > 0 && at - (starts[index - 1] ?? at) > 5000);
    expect(holeEnd).toBeDefined();
    expect(firsts.some((at) => at >= (holeEnd ?? Infinity))).toBe(true);
  });

  it('PROX-59: o mesmo token sumindo e voltando a cada 3 s passa pelo portão; o encosto recusado não muda a fase; o QR em destaque aparece aos 20 s do último encosto admitido; o portão reabre', async () => {
    const server = touchServer();
    const { radio, result } = await setup({ touches: server.handler });
    const phases: { at: number; phase: TouchPhase }[] = [{ at: Date.now(), phase: 'idle' }];
    const start = Date.now();
    // 150 s: tM no ar por 1,4 s ("encostado") e fora por 1,6 s, a cada 3 s.
    const step = CAL.sightingMinIntervalMs;
    for (let tick = 0; tick * step < 150_000; tick += 1) {
      await act(async () => {
        if (tick % 15 < 7) radio.emitSighting(TM, TX_REF - TOUCH_LOSS);
        await jest.advanceTimersByTimeAsync(step);
      });
      const phase = result.current.phase;
      if (phases.at(-1)?.phase !== phase) phases.push({ at: Date.now(), phase });
    }
    const starts = server.starts();
    // Sem o portão, o relato iria a 1/s pelos 150 s (o prazo se estenderia a cada volta).
    expect(maxPerMinute(starts)).toBeLessThanOrEqual(39);
    expect(server.limited()).toBe(0);

    // O 1º "Não deu para confirmar" só sai quando o portão recusa o encosto: 4 s depois do último
    // admitido. Daí até os 20 s desse encosto, nenhum "Encostou!", embora o token volte a cada 3 s.
    const warned = phases.find((entry) => entry.phase === 'notConfirmed');
    expect(warned).toBeDefined();
    const lastAdmitted = (warned?.at ?? 0) - CAL.confirmWarnAfterMs;
    expect(lastAdmitted - start).toBeGreaterThan(25_000);
    const hint = phases.find((entry) => entry.phase === 'noTouch' && entry.at > lastAdmitted);
    expect(hint).toBeDefined();
    expect((hint?.at ?? 0) - lastAdmitted).toBeGreaterThanOrEqual(CAL.noTouchFallbackMs);
    expect((hint?.at ?? 0) - lastAdmitted).toBeLessThanOrEqual(CAL.noTouchFallbackMs + 400);
    expect(
      phases.some(
        (entry) =>
          entry.phase === 'confirming' &&
          entry.at > (warned?.at ?? 0) &&
          entry.at <= (hint?.at ?? 0),
      ),
    ).toBe(false);
    // O portão reabre quando os inícios antigos saem dos 60 s: o encosto volta a entrar.
    expect(phases.some((entry) => entry.phase === 'confirming' && entry.at > (hint?.at ?? 0))).toBe(
      true,
    );
  });

  it('PROX-59: com o portão fechado, o encosto real mais forte é ignorado (o relato segue com o último aceito); quando o portão abre, é ele o admitido e o cartão chega', async () => {
    const real = nearbyPerson({ token: REAL, handle: 'bia', name: 'Bia Lemos' });
    let carded = false;
    const server = touchServer((token) => {
      if (token !== REAL || carded) return EMPTY;
      carded = true;
      return { status: 200, body: { items: [touchItem(real)] } };
    });
    const { radio, result, onCard } = await setup({ touches: server.handler });
    const phases: { at: number; phase: TouchPhase }[] = [];
    const start = Date.now();
    // O portão fecha uns 31 s depois do começo; a pessoa de verdade (a de menor perda) encosta aos
    // 33 s, com o portão fechado e o prazo do último aceito ainda aberto, e fica encostada.
    await rotate(
      radio,
      100_000,
      phases,
      () => result.current.phase,
      (elapsed) => (elapsed >= 32_000 ? [{ token: REAL, loss: 15 }] : []),
    );
    const realReports = server.sent.filter((call) => call.token === REAL);
    expect(realReports.length).toBeGreaterThan(0);
    const firstReal = realReports[0]?.at ?? 0;
    // Enquanto o portão estava fechado, ela não foi relatada, embora fosse a mais forte.
    expect(firstReal - start).toBeGreaterThan(55_000);
    expect(
      server.starts().filter((at) => at > firstReal - MINUTE && at < firstReal).length,
    ).toBeLessThanOrEqual(30);
    const before = server.sent.filter((call) => call.at > start + 33_400 && call.at < firstReal);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((call) => call.token !== REAL)).toBe(true);
    // Admitida, é ela que vai no relato (a de menor perda) e o cartão chega.
    expect(onCard).toHaveBeenCalledTimes(1);
    expect((onCard.mock.calls[0] as [{ person: unknown }])[0].person).toEqual(real);
  });
});

describe('useTouch: fases da tela e o QR em destaque (ux.md §11.4, P9)', () => {
  it('Aproximando no "quase"; volta ao Pronto só depois de 2 s sem sinal (sem piscar)', async () => {
    const { radio, result, reports } = await setup();
    expect(result.current.phase).toBe('idle');
    await sight(radio, 800, [{ token: CAIO, loss: NEAR_LOSS }]);
    expect(result.current.phase).toBe('approaching');
    // O sinal some quando a janela da mediana esvazia; daí, mais 2 s até sair do Aproximando.
    await advance(CAL.windowMs + connectTiming.approachingLeaveMs - 600);
    expect(result.current.phase).toBe('approaching');
    await advance(600);
    expect(result.current.phase).toBe('idle');
    // "Quase" não identifica ninguém: nada vai para o servidor.
    expect(reports()).toHaveLength(0);
  });

  it('Confirmando → "Não deu para confirmar" aos 4 s → Pronto 6 s depois', async () => {
    const { radio, result } = await setup();
    await touch(radio);
    expect(result.current.phase).toBe('confirming');
    expect(result.current.keepAwake).toBe(true);
    const demoBefore = result.current.demoRun;
    await advance(CAL.confirmWarnAfterMs);
    expect(result.current.phase).toBe('notConfirmed');
    // O aviso volta ao Pronto: a ilustração roda a demonstração de novo.
    expect(result.current.demoRun).toBe(demoBefore + 1);
    await advance(connectTiming.notConfirmedNoticeMs);
    expect(result.current.phase).toBe('idle');
  });

  it('P9: QR em destaque aos 20 s no Pronto sem encostar', async () => {
    const { result } = await setup();
    await advance(CAL.noTouchFallbackMs - 400);
    expect(result.current.phase).toBe('idle');
    await advance(600);
    expect(result.current.phase).toBe('noTouch');
  });

  it('P9: QR em destaque aos 10 s no "quase" sem chegar ao encosto', async () => {
    const { radio, result } = await setup();
    await sight(radio, CAL.nearFallbackMs - 600, [{ token: CAIO, loss: NEAR_LOSS }]);
    expect(result.current.phase).toBe('approaching');
    await sight(radio, 1000, [{ token: CAIO, loss: NEAR_LOSS }]);
    expect(result.current.phase).toBe('noTouch');
  });

  it('P9: QR em destaque depois de dois "Não deu para confirmar" seguidos', async () => {
    const { radio, result } = await setup();
    await touch(radio);
    await advance(CAL.confirmWarnAfterMs + connectTiming.notConfirmedNoticeMs);
    expect(result.current.phase).toBe('idle');
    await touch(radio);
    expect(result.current.phase).toBe('confirming');
    await advance(CAL.confirmWarnAfterMs);
    expect(result.current.phase).toBe('notConfirmed');
    await advance(connectTiming.notConfirmedNoticeMs);
    expect(result.current.phase).toBe('noTouch');
  });

  it('tela acesa: no Pronto só nos primeiros 2 min sem encostar', async () => {
    const { result } = await setup();
    expect(result.current.keepAwake).toBe(true);
    await advance(connectTiming.keepAwakeIdleMs + 400);
    expect(result.current.keepAwake).toBe(false);
  });
});

describe('useTouch: varredura e erros', () => {
  it('P7: no Android a varredura começa ~500 ms depois e é uma só por visita (mudar de estado não reinicia)', async () => {
    const { radio, rerender } = await setup({ platform: 'android' });
    expect(radio.scanning).toBe(false);
    await advance(CAL.scanStartDelayMs.android - 10);
    expect(radio.scanning).toBe(false);
    await advance(10);
    expect(radio.scanning).toBe(true);
    expect(radio.scanMinIntervalMs).toBe(CAL.sightingMinIntervalMs);
    // Cartão, pedido, volta ao Pronto: a varredura segue a mesma.
    await rerender({ listening: false, scanning: true });
    await rerender({ listening: true, scanning: true });
    await rerender({ listening: false, scanning: true });
    await advance(5000);
    expect(radio.scanStarts).toBe(1);
    expect(radio.scanning).toBe(true);
    // Saiu da aba (ou foi ao QR): para.
    await rerender({ listening: false, scanning: false });
    await advance(0);
    expect(radio.scanning).toBe(false);
  });

  it('409 (tela fechada): renova os tokens e o relato continua; 429: vai para a tela e para', async () => {
    let calls = 0;
    const closed = await setup({
      touches: () => {
        calls += 1;
        return calls === 1 ? apiError(409, 'PROXIMITY_SCREEN_CLOSED') : EMPTY;
      },
    });
    await touch(closed.radio);
    await advance(3000);
    expect(closed.refreshScreen).toHaveBeenCalledTimes(1);
    expect(closed.reports().length).toBeGreaterThan(2);
    expect(closed.onReportError).not.toHaveBeenCalled();
    await closed.unmount();
    await advance(CAL.reportEveryMs);

    const limited = await setup({ touches: apiError(429, 'RATE_LIMITED') });
    await touch(limited.radio);
    await advance(5000);
    expect(limited.reports()).toHaveLength(1);
    expect(limited.onReportError).toHaveBeenCalledTimes(1);
    expect(limited.onReportError.mock.calls[0]?.[0]).toBeInstanceOf(ApiError);
  });

  it('erro ao ligar a varredura vai para a tela', async () => {
    const api = createFakeApi();
    const radio = createFakeRadio();
    radio.startScan = () => Promise.reject(new Error('scan'));
    const onScanError = jest.fn();
    await renderHook(() =>
      useTouch({
        api: new ApiClient({
          baseUrl: BASE_URL,
          fetch: api.fetch,
          tokens: createMemorySessionStore({}),
        }),
        radio,
        receiver: { platform: 'ios', model: '' },
        scanning: true,
        listening: true,
        onCard: jest.fn(),
        onReportError: jest.fn(),
        onScanError,
        refreshScreen: () => Promise.resolve(),
      }),
    );
    await advance(0);
    expect(onScanError).toHaveBeenCalledTimes(1);
  });

  it('dev (simulate-touch): o bleToken da persona é relatado como um encosto', async () => {
    const lucas = nearbyPerson({ token: LUCAS, handle: 'lucasf', name: 'Lucas Ferreira' });
    const { reported, result, onCard } = await setup({
      touches: mutualTouches({ [LUCAS]: lucas }, 0),
    });
    await act(async () => {
      result.current.simulate(LUCAS);
      await Promise.resolve();
    });
    await advance(0);
    expect(reported()).toEqual([[LUCAS]]);
    expect(onCard).toHaveBeenCalledTimes(1);
  });
});
