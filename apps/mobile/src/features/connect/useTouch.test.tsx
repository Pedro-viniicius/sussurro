import {
  PROXIMITY_TOUCH_LIMIT_PER_MIN,
  PROXIMITY_TOUCH_REPORT_FOR_S,
  PROXIMITY_TOUCH_REPORT_INTERVAL_S,
  PROXIMITY_TOUCH_WINDOW_S,
} from '@sussurro/shared';
import { act, renderHook } from '@testing-library/react-native';

import { connectTiming } from './timing';
import { cardActionsUntil, cardTtlMs, TOUCH_CALIBRATION } from './touch-calibration';
import type { TouchReceiver } from './touch-detector';
import {
  resetTouchReportGate,
  type TouchCard,
  type TouchPhase,
  useTouch,
  useTouchSessionScope,
} from './useTouch';
import {
  createFakeRadio,
  type FakeRadio,
} from '../../../modules/sussurro-proximity/src/fake-radio';
import { ApiClient } from '../../lib/api/client';
import { ApiError, NetworkError } from '../../lib/api/errors';
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
/** As contas da sessão (o `id` do usuário logado). */
const ACCOUNT_A = '01a189e0-af57-7000-85fe-2054e618fea6';
const ACCOUNT_B = '01a189e0-af57-7000-85fe-2054e618feb1';
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
    /** O que a tela responde ao cartão (padrão: mostrou, `true`). */
    onCard?: (card: TouchCard) => boolean;
    refreshScreen?: () => Promise<void>;
    /** A conta da sessão (padrão: a mesma em todos os motores). */
    ownerId?: string;
  } = {},
) {
  const api = options.api ?? createFakeApi();
  if (options.api === undefined || options.touches !== undefined) {
    api.on('POST /v1/proximity/touches', options.touches ?? EMPTY);
  }
  const radio = options.radio ?? createFakeRadio();
  /** O `signal` de cada relato (o prazo de 4 s aborta a conexão, A3-3 item 1). */
  const signals: (AbortSignal | undefined)[] = [];
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: (url, init) => {
      if (url.endsWith('/v1/proximity/touches')) signals.push(init.signal);
      return api.fetch(url, init);
    },
    tokens: createMemorySessionStore({}),
  });
  const receiver: TouchReceiver = { platform: options.platform ?? 'ios', model: 'Teste' };
  const onCard = jest.fn((card: TouchCard) => options.onCard?.(card) ?? true);
  const onReportError = jest.fn();
  const onScanError = jest.fn();
  const refreshScreen = jest.fn(options.refreshScreen ?? (() => Promise.resolve()));
  const hook = await renderHook(
    (props: { listening: boolean; scanning: boolean }) =>
      useTouch({
        api: http,
        ownerId: options.ownerId ?? ACCOUNT_A,
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
    signals,
  };
}

/** O relato que não chega ao servidor (sem rede): o `fetch` falha e vira `NetworkError`. */
function offline(): never {
  throw new Error('sem rede');
}

/** O relato que nunca responde (conexão travada): só o prazo de 4 s o encerra. */
function hang(): Promise<FakeReply> {
  return new Promise(() => undefined);
}

/**
 * Simula um encosto (o mesmo portão e o mesmo ritmo do encosto de verdade, R1-3 item 8) e deixa a
 * resposta imediata chegar.
 */
async function simulateTouch(
  result: { current: { simulate: (token: string) => void } },
  token: string,
) {
  await act(async () => {
    result.current.simulate(token);
    await Promise.resolve();
  });
  await advance(0);
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
    const [card] = onCard.mock.calls[0] as [TouchCard];
    // O `pairExpiresInS` serve só ao prazo: o cartão guarda a pessoa.
    expect(card.person).toEqual(caio);
    expect(card.actionsUntil - card.matchedAt).toBe(55_000);

    // Ainda encostados e o tempo passa: nada mais é relatado.
    await sight(radio, 3000, [{ token: CAIO, loss: TOUCH_LOSS }]);
    await advance(10_000);
    expect(reports()).toHaveLength(2);
    expect(result.current.phase).not.toBe('confirming');
  });

  it('P3: o casamento depois do aviso dos 7 s ainda abre o cartão (9 → 11)', async () => {
    // O 1º relato responde em 3 s (o prazo vai a 11 s); o cartão vem no relato dos 8 s.
    const caio = touchItem(nearbyPerson({ token: CAIO }));
    const server = touchServer((_token, index) => {
      if (index === 0) return later(3000);
      return { status: 200, body: { items: index >= 6 ? [caio] : [] } };
    });
    const { radio, onCard, result } = await setup({ touches: server.handler });
    await touch(radio);
    const [touchedAt = 0] = server.starts();
    await advance(touchedAt + CAL.confirmWarnAfterMs + 200 - Date.now());
    expect(result.current.phase).toBe('notConfirmed');
    expect(onCard).not.toHaveBeenCalled();
    await advance(1000);
    expect(onCard).toHaveBeenCalledTimes(1);
    expect((server.sent[6]?.at ?? 0) - touchedAt).toBe(8000);
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
  it('PROX-64: actionsUntil = chegada + min(55 s, pairExpiresInS × 1000), sem descontar a margem de novo', () => {
    // O servidor já arredonda para baixo em múltiplos de 5 s: 55 no casamento na hora.
    expect(cardTtlMs()).toBe(55_000);
    expect(cardActionsUntil(1000, 55)).toBe(1000 + 55_000);
    expect(cardActionsUntil(1000, 60)).toBe(1000 + cardTtlMs());
    expect(cardActionsUntil(1000, 10)).toBe(1000 + 10_000);
    expect(cardActionsUntil(1000, 0)).toBe(1000);
  });

  it('PROX-64: o cartão devido que chega tarde (pairExpiresInS = 10) tem ações por 10 s, e não 55 s depois da chegada', async () => {
    const late = touchItem(nearbyPerson({ token: CAIO }), 10);
    const { radio, onCard } = await setup({ touches: mutualTouches({ [CAIO]: late }) });
    await touch(radio);
    await advance(1000);
    expect(onCard).toHaveBeenCalledTimes(1);
    const [card] = onCard.mock.calls[0] as [TouchCard];
    expect(card.actionsUntil - card.matchedAt).toBe(10_000);
    expect(card.late).toBe(false);
  });
});

describe('useTouch: PROX-57, token novo e prazo que só cresce (ADR 0012, A2 rev. 1, R1-3)', () => {
  it('PROX-57: reportForMs vem do contrato (8 s) e cobre a janela do casamento + 2 s de latência', () => {
    expect(CAL.reportForMs).toBe(PROXIMITY_TOUCH_REPORT_FOR_S * 1000);
    expect(CAL.reportForMs).toBeGreaterThanOrEqual((PROXIMITY_TOUCH_WINDOW_S + 2) * 1000);
  });

  it('PROX-57: o 1º relato responde em 3 s → o relato vai até 8 s depois da resposta; o aviso dos 7 s não muda', async () => {
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

    // O 1º "Não deu para confirmar" só sai quando o portão recusa o encosto: 7 s depois do último
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

  it('PROX-70: Confirmando → "Não deu para confirmar" aos 7 s (não mais aos 4) → Pronto 6 s depois', async () => {
    const { radio, result } = await setup();
    await touch(radio);
    expect(result.current.phase).toBe('confirming');
    expect(result.current.keepAwake).toBe(true);
    const demoBefore = result.current.demoRun;
    // O encosto foi admitido ~200 ms antes do fim do `touch`: aos 6,6 s, ainda "Encostou!".
    await advance(CAL.confirmWarnAfterMs - 600);
    expect(result.current.phase).toBe('confirming');
    await advance(600);
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
        ownerId: ACCOUNT_A,
        radio,
        receiver: { platform: 'ios', model: '' },
        scanning: true,
        listening: true,
        onCard: jest.fn(() => true),
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

describe('useTouch: PROX-68, falha de rede no relato (ADR 0012, A3-3 itens 1 a 3 e 7)', () => {
  it('PROX-68: constantes do A3 — prazo de 4 s, repetição a cada 2 s, reentrega de 2 × a janela (10 s), cartão atrasado abaixo de 10 s', () => {
    expect(CAL.reportTimeoutMs).toBe(4000);
    expect(CAL.reportRetryEveryMs).toBe(2000);
    expect(CAL.cardRedeliveryMs).toBe(2 * PROXIMITY_TOUCH_WINDOW_S * 1000);
    expect(CAL.cardRedeliveryMs).toBe(10_000);
    expect(CAL.lateCardBelowMs).toBe(10_000);
    // A repetição nunca é mais rápida que o ritmo de sempre (um relato por vez, R1-3).
    expect(CAL.reportRetryEveryMs).toBeGreaterThanOrEqual(CAL.reportEveryMs);
  });

  it('PROX-68: o relato sem resposta em 4 s é abortado (o signal do fetch) e vira falha repetível: o mesmo token sai de novo e a tela não para', async () => {
    const server = touchServer((_token, index) => (index === 0 ? hang() : EMPTY));
    const { radio, signals, onReportError, result } = await setup({ touches: server.handler });
    await touch(radio);
    const [touchedAt = 0] = server.starts();
    await advance(touchedAt + CAL.reportTimeoutMs - 1 - Date.now());
    expect(server.sent).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await advance(1);
    expect(signals[0]?.aborted).toBe(true);
    // Os 2 s desde o início já passaram: a repetição sai na hora, com o mesmo token.
    expect(server.sent.map((call) => [call.at - touchedAt, call.token])).toEqual([
      [0, CAIO],
      [4000, CAIO],
    ]);
    expect(result.current.phase).toBe('confirming');
    await advance(20_000);
    expect(onReportError).not.toHaveBeenCalled();
  });

  it.each([
    ['sem rede', offline, [0, 2000, 4000, 6000, 8000], 10_000, NetworkError],
    [
      '503',
      () => apiError(503, 'PROXIMITY_UNAVAILABLE'),
      [0, 2000, 4000, 6000, 8000],
      10_000,
      ApiError,
    ],
    ['prazo de 4 s', hang, [0, 4000, 8000], 12_000, NetworkError],
  ] as const)(
    'PROX-68: falha repetível (%s) → o mesmo token, um relato por vez, a cada 2 s, até 10 s depois do início do 1º que falhou; terminou aberta → a tela para com o erro',
    async (_case, fail, expectedStarts, haltAt, errorType) => {
      const server = touchServer(() => fail());
      const { radio, onReportError, result } = await setup({ touches: server.handler });
      await touch(radio);
      const [touchedAt = 0] = server.starts();
      await advance(touchedAt + haltAt - 1 - Date.now());
      expect(onReportError).not.toHaveBeenCalled();
      // A tela não parou: o aviso de sempre (7 s) saiu.
      expect(result.current.phase).toBe('notConfirmed');
      await advance(1);
      expect(onReportError).toHaveBeenCalledTimes(1);
      expect(onReportError.mock.calls[0]?.[0]).toBeInstanceOf(errorType);
      await advance(20_000);
      expect(server.starts().map((at) => at - touchedAt)).toEqual(expectedStarts);
      expect(server.sent.every((call) => call.token === CAIO)).toBe(true);
      expect(gaps(server.starts()).every((gap) => gap >= CAL.reportRetryEveryMs)).toBe(true);
    },
  );

  it('PROX-68: a tela para com o último erro da sequência (503 quatro vezes e, por fim, sem rede → "Sem internet")', async () => {
    const server = touchServer((_token, index) =>
      index < 4 ? apiError(503, 'PROXIMITY_UNAVAILABLE') : offline(),
    );
    const { radio, onReportError } = await setup({ touches: server.handler });
    await touch(radio);
    await advance(15_000);
    expect(server.sent).toHaveLength(5);
    expect(onReportError).toHaveBeenCalledTimes(1);
    expect(onReportError.mock.calls[0]?.[0]).toBeInstanceOf(NetworkError);
  });

  it('PROX-68: qualquer 200 encerra a sequência — o encosto mais forte no meio dela espera; depois do 200, voltam o ritmo de 1 s e a escolha do P8', async () => {
    const server = touchServer((token, index) => (token === CAIO && index < 2 ? offline() : EMPTY));
    const { radio, onReportError } = await setup({ touches: server.handler });
    await touch(radio, CAIO);
    const [touchedAt = 0] = server.starts();
    // Bia encosta (mais forte) com a sequência aberta: o relato repete Caio até o 200.
    await sight(radio, 4800, [{ token: BIA, loss: 20 }]);
    await advance(20_000);
    const sent = server.sent.map((call) => [call.at - touchedAt, call.token]);
    expect(sent.slice(0, 4)).toEqual([
      [0, CAIO],
      [2000, CAIO],
      [4000, CAIO],
      [5000, BIA],
    ]);
    expect(onReportError).not.toHaveBeenCalled();
  });

  it.each([
    ['429', apiError(429, 'RATE_LIMITED')],
    ['403', apiError(403, 'ACCOUNT_TYPE_NOT_ALLOWED')],
    ['400', apiError(400, 'PROXIMITY_TOKEN_INVALID')],
  ] as const)('PROX-68: %s para a tela na hora, sem repetir', async (_case, reply) => {
    const { radio, reports, onReportError } = await setup({ touches: reply });
    await touch(radio);
    await advance(15_000);
    expect(reports()).toHaveLength(1);
    expect(onReportError).toHaveBeenCalledTimes(1);
    expect(onReportError.mock.calls[0]?.[0]).toMatchObject({ status: reply.status });
  });

  it.each([
    ['sem rede', true, new NetworkError()],
    ['503', true, new ApiError(503, 'PROXIMITY_UNAVAILABLE', 'x')],
    ['429', false, new ApiError(429, 'RATE_LIMITED', 'x')],
  ] as const)(
    'PROX-68: 409 cuja renovação falha (%s) → conta como falha repetível: %s',
    async (_case, repeatable, error) => {
      let renewals = 0;
      const server = touchServer((_token, index) =>
        index === 0 ? apiError(409, 'PROXIMITY_SCREEN_CLOSED') : EMPTY,
      );
      const { radio, onReportError, refreshScreen } = await setup({
        touches: server.handler,
        refreshScreen: () => {
          renewals += 1;
          return renewals === 1 ? Promise.reject(error) : Promise.resolve();
        },
      });
      await touch(radio);
      const [touchedAt = 0] = server.starts();
      await advance(20_000);
      expect(refreshScreen).toHaveBeenCalledTimes(1);
      if (repeatable) {
        // Repetido 2 s depois, com o mesmo token; o 200 encerra a sequência e a tela não para.
        expect(server.sent.slice(0, 2).map((call) => [call.at - touchedAt, call.token])).toEqual([
          [0, CAIO],
          [2000, CAIO],
        ]);
        expect(onReportError).not.toHaveBeenCalled();
      } else {
        expect(server.sent).toHaveLength(1);
        expect(onReportError).toHaveBeenCalledWith(error);
      }
    },
  );

  it('PROX-68: sair do Pronto com a sequência aberta → nada mais é relatado, e a tela não para', async () => {
    const server = touchServer(() => offline());
    const { radio, rerender, onReportError } = await setup({ touches: server.handler });
    await touch(radio);
    await advance(3000);
    await rerender({ listening: false, scanning: true });
    const before = server.sent.length;
    await advance(20_000);
    expect(server.sent).toHaveLength(before);
    expect(onReportError).not.toHaveBeenCalled();
  });

  /** O token admitido no pior caso do orçamento (aos 30 s, com 30 inícios antes). */
  const TW = 'OrcamentoTokenW1';

  /**
   * O pior caso do portão: A, B e C com 8 inícios cada (aos 0, 8 e 16 s) e D com 6 (o cartão no 6º,
   * aos 24 s) dão 30 inícios nos últimos 60 s; W é admitido aos 30 s (o portão deixa com ≤ 30) e
   * responde por `w(índice do relato de W)`.
   */
  async function budgetWorstCase(w: (index: number) => FakeReply | Promise<FakeReply>) {
    const TD = 'OrcamentoTokenD1';
    const dani = touchItem(nearbyPerson({ token: TD, handle: 'dani', name: 'Dani Prado' }));
    const server = touchServer((token) => {
      const index = server.sent.filter((call) => call.token === token).length - 1;
      if (token === TD) return index === 5 ? { status: 200, body: { items: [dani] } } : EMPTY;
      return token === TW ? w(index) : EMPTY;
    });
    const hook = await setup({ touches: server.handler });
    const start = Date.now();
    const admitAt = async (token: string, at: number) => {
      await advance(start + at - Date.now());
      await simulateTouch(hook.result, token);
    };
    await admitAt('OrcamentoTokenA1', 0);
    await admitAt('OrcamentoTokenB1', 8000);
    await admitAt('OrcamentoTokenC1', 16_000);
    await admitAt(TD, 24_000);
    await advance(start + 30_000 - Date.now());
    expect(server.sent).toHaveLength(30);
    await admitAt(TW, 30_000);
    return { ...hook, server, start };
  }

  it('PROX-68 / PROX-59: pior caso por admissão com falhas (A3-3 item 7) — 30 inícios antes, a admissão, o prazo, a sequência e o 200 que a encerra estendendo o prazo: ≤ 52 em 60 s, sem 429', async () => {
    // W: o 1º responde em 0,5 s (o prazo vai a 8,5 s), o 9º (aos 8 s) abre a sequência, que falha
    // até o 200 dos 16 s (0,5 s), que estende o prazo de novo (aceito há 9,5 s).
    const { server, start, onReportError } = await budgetWorstCase((index) => {
      if (index === 0 || index === 12) return later(500);
      if (index >= 8 && index <= 11) return offline();
      return EMPTY;
    });
    await advance(40_000);

    const w = server.sent.filter((call) => call.token === TW).map((call) => call.at - start);
    expect(w).toEqual([
      // A admissão e o prazo (até 38,5 s): 9 inícios.
      30_000, 31_000, 32_000, 33_000, 34_000, 35_000, 36_000, 37_000, 38_000,
      // A sequência (até 48 s, a cada 2 s, sem o portão): 4 inícios; o 200 dos 46 s a encerra.
      40_000, 42_000, 44_000, 46_000,
      // O 200 estende o prazo uma vez (até 54,5 s): mais 8.
      47_000, 48_000, 49_000, 50_000, 51_000, 52_000, 53_000, 54_000,
    ]);
    // 30 + 1 + 8 + 4 + 8 = 51: a sequência acrescenta no máximo 4 inícios (o dos 10 s já não
    // sai); o A3 conta 5, com folga. Abaixo dos 52 do A3 e dos 60 do servidor.
    const starts = server.starts();
    expect(maxPerMinute(starts)).toBe(51);
    expect(maxPerMinute(starts)).toBeLessThanOrEqual(52);
    expect(server.limited()).toBe(0);
    expect(onReportError).not.toHaveBeenCalled();
  });

  it('PROX-68: rede que alterna (7 respostas, 2 falhas) por 3 min numa admissão só — cada 200 depois de ≥ 5 s sem aceite estende o prazo de novo; nunca chega aos 60 do servidor (sem 429)', async () => {
    // Em cada ciclo de 9 relatos de W: 7 respostas e 2 falhas (11 s; o 200 seguinte é "novo").
    const { server, onReportError } = await budgetWorstCase((index) =>
      index % 9 >= 7 ? offline() : EMPTY,
    );
    await advance(3 * MINUTE);
    const starts = server.starts();
    // A cadeia se sustenta: uns 49 relatos por minuto de W, sem admissão nova.
    expect(server.sent.filter((call) => call.token === TW).length).toBeGreaterThan(140);
    // Medido em 2026-10-31: 56 em 60 s com os 30 de antes da admissão. Passa dos 52 "por admissão"
    // do A3-3 item 7 (que não conta a extensão repetida) e fica abaixo dos 60 do servidor.
    expect(maxPerMinute(starts)).toBeLessThan(PROXIMITY_TOUCH_LIMIT_PER_MIN);
    expect(server.limited()).toBe(0);
    expect(onReportError).not.toHaveBeenCalled();
  });
});

describe('useTouch: PROX-69, reentrega e cartão fora do Pronto (ADR 0012, A3-3 itens 5 e 6)', () => {
  const caio = touchItem(nearbyPerson({ token: CAIO }));
  const withCaio: FakeReply = { status: 200, body: { items: [caio] } };

  it('PROX-69: o mesmo @ do último cartão mostrado há menos de 10 s é ignorado — não abre cartão, não estende o prazo e não para o relator; aos 10 s, aparece', async () => {
    const server = touchServer((_token, index) => (index === 1 ? later(1500, withCaio) : withCaio));
    const { result, onCard } = await setup({ touches: server.handler });
    const start = Date.now();
    await simulateTouch(result, CAIO);
    expect(onCard).toHaveBeenCalledTimes(1);
    const [shown] = onCard.mock.calls[0] as [TouchCard];
    expect(shown.matchedAt).toBe(start);

    // Fecha o cartão e encosta de novo logo: o servidor reentrega o mesmo cartão.
    await advance(1000);
    await simulateTouch(result, CAIO);
    await advance(start + 8200 - Date.now());
    expect(onCard).toHaveBeenCalledTimes(1);
    // O relator seguiu (o aviso dos 7 s saiu) até o prazo do encosto (1 + 8 s), sem estender pela
    // resposta (a 1ª em 1,5 s): 1; 2,5; 3,5 … 8,5 s.
    expect(result.current.phase).toBe('notConfirmed');
    await advance(start + 9900 - Date.now());
    expect(server.starts().map((at) => at - start)).toEqual([
      0, 1000, 2500, 3500, 4500, 5500, 6500, 7500, 8500,
    ]);

    // Aos 10 s do cartão mostrado, o mesmo @ aparece de novo.
    await advance(start + 10_000 - Date.now());
    await simulateTouch(result, CAIO);
    expect(onCard).toHaveBeenCalledTimes(2);
  });

  it('PROX-69: o cartão mostrado por outra instância do motor também conta (o estado fica no módulo)', async () => {
    const api = createFakeApi();
    api.on('POST /v1/proximity/touches', withCaio);
    const before = await setup({ api });
    const start = Date.now();
    await simulateTouch(before.result, CAIO);
    expect(before.onCard).toHaveBeenCalledTimes(1);
    await before.unmount();

    const after = await setup({ api });
    await advance(start + 2000 - Date.now());
    await simulateTouch(after.result, CAIO);
    await advance(start + 9900 - Date.now());
    expect(after.onCard).not.toHaveBeenCalled();
    await advance(start + 10_000 - Date.now());
    await simulateTouch(after.result, CAIO);
    expect(after.onCard).toHaveBeenCalledTimes(1);
  });

  it('PROX-69: o último cartão é da conta — o motor de outra conta recebe o mesmo @ em menos de 10 s e ele aparece, mesmo sem a limpeza da sessão', async () => {
    const api = createFakeApi();
    api.on('POST /v1/proximity/touches', withCaio);
    const before = await setup({ api, ownerId: ACCOUNT_A });
    const start = Date.now();
    await simulateTouch(before.result, CAIO);
    expect(before.onCard).toHaveBeenCalledTimes(1);
    await before.unmount();

    const after = await setup({ api, ownerId: ACCOUNT_B });
    await advance(start + 2000 - Date.now());
    await simulateTouch(after.result, CAIO);
    expect(after.onCard).toHaveBeenCalledTimes(1);
    const [card] = after.onCard.mock.calls[0] as [TouchCard];
    expect(card.person.handle).toBe('caio.r');
    expect(Date.now() - start).toBeLessThan(CAL.cardRedeliveryMs);
  });

  it.each<{ when: string; sessions: (string | null)[]; nextOwner: string; calls: number }>([
    { when: 'a mesma conta, sem sair', sessions: [ACCOUNT_A], nextOwner: ACCOUNT_A, calls: 0 },
    {
      when: 'saiu (sem conta) e entrou de novo a mesma conta',
      sessions: [null, ACCOUNT_A],
      nextOwner: ACCOUNT_A,
      calls: 1,
    },
    {
      when: 'saiu e entrou outra conta',
      sessions: [null, ACCOUNT_B],
      nextOwner: ACCOUNT_B,
      calls: 1,
    },
    { when: 'trocou de conta direto', sessions: [ACCOUNT_B], nextOwner: ACCOUNT_B, calls: 1 },
  ])(
    'PROX-69: useTouchSessionScope — $when → o mesmo @ em menos de 10 s vai para a tela $calls vez(es)',
    async ({ sessions, nextOwner, calls }) => {
      const scope = await renderHook(
        (props: { ownerId: string | null }) => {
          useTouchSessionScope(props.ownerId);
        },
        { initialProps: { ownerId: ACCOUNT_A } },
      );
      const api = createFakeApi();
      api.on('POST /v1/proximity/touches', withCaio);
      const before = await setup({ api, ownerId: ACCOUNT_A });
      const start = Date.now();
      await simulateTouch(before.result, CAIO);
      expect(before.onCard).toHaveBeenCalledTimes(1);
      await before.unmount();
      for (const ownerId of sessions) await scope.rerender({ ownerId });

      const after = await setup({ api, ownerId: nextOwner });
      await advance(start + 2000 - Date.now());
      await simulateTouch(after.result, CAIO);
      await advance(start + 9900 - Date.now());
      expect(after.onCard).toHaveBeenCalledTimes(calls);
    },
  );

  /** O escopo da sessão, como o `RootNavigator` o chama, começando logado na conta A. */
  function sessionScope() {
    return renderHook(
      (props: { ownerId: string | null }) => {
        useTouchSessionScope(props.ownerId);
      },
      { initialProps: { ownerId: ACCOUNT_A } },
    );
  }

  /** A conta A sai (`null`) e a conta B entra, com a tela do motor de A já desmontada. */
  async function signOutAndIn(scope: Awaited<ReturnType<typeof sessionScope>>) {
    await scope.rerender({ ownerId: null });
    await scope.rerender({ ownerId: ACCOUNT_B });
  }

  it.each<{ when: string; replyMs: number; gapMs: number }>([
    {
      when: 'com o relato de A em voo (resposta em 1,8 s), o 1º relato de B espera a resposta (inFlight)',
      replyMs: 1800,
      gapMs: 1800,
    },
    {
      when: 'com o relato de A já respondido, o 1º relato de B espera 1 s do início dele (lastStartAt)',
      replyMs: 0,
      gapMs: CAL.reportEveryMs,
    },
  ])(
    'PROX-69 (PROX-58): useTouchSessionScope não zera o ritmo do processo — sair e entrar com outra conta logo depois de um relato: $when',
    async ({ replyMs, gapMs }) => {
      const scope = await sessionScope();
      const server = touchServer((_token, index) =>
        index === 0 && replyMs > 0 ? later(replyMs) : EMPTY,
      );
      const api = createFakeApi();
      api.on('POST /v1/proximity/touches', server.handler);
      const before = await setup({ api, ownerId: ACCOUNT_A });
      await touch(before.radio, CAIO);
      const [first = 0] = server.starts();
      // A troca de conta acontece antes do 2º relato de A e antes da espera que se quer medir.
      expect(server.sent).toHaveLength(1);
      expect(Date.now() - first).toBeLessThan(Math.min(gapMs, CAL.reportEveryMs));
      await before.unmount();
      await signOutAndIn(scope);

      const after = await setup({ api, ownerId: ACCOUNT_B });
      await act(async () => {
        after.result.current.simulate(LUCAS);
        await Promise.resolve();
      });
      await advance(10_000);
      expect(server.sent.slice(0, 2).map((call) => call.token)).toEqual([CAIO, LUCAS]);
      expect((server.sent[1]?.at ?? 0) - first).toBe(gapMs);
      expect(server.maxInFlight()).toBe(1);
    },
  );

  it('PROX-69 (PROX-59): useTouchSessionScope não zera o orçamento do processo — com mais de 30 inícios de A nos últimos 60 s, o encosto de B logo depois da troca é recusado; reabre quando os inícios de A saem dos 60 s', async () => {
    const scope = await sessionScope();
    const server = touchServer();
    const api = createFakeApi();
    api.on('POST /v1/proximity/touches', server.handler);
    const before = await setup({ api, ownerId: ACCOUNT_A });
    // Um token novo por segundo por 40 s: relatos a 1/s, e o portão fecha depois de 31 inícios.
    for (let index = 0; index < 40; index += 1) {
      await act(async () => {
        before.result.current.simulate(`ContaA${String(index).padStart(10, '0')}`);
        await Promise.resolve();
      });
      await advance(1000);
    }
    const [first = 0] = server.starts();
    const used = server.starts().length;
    expect(used).toBeGreaterThan(CAL.reportBudgetPerMinute - CAL.reportReserve);
    await before.unmount();
    await signOutAndIn(scope);

    const after = await setup({ api, ownerId: ACCOUNT_B });
    await act(async () => {
      after.result.current.simulate(LUCAS);
      await Promise.resolve();
    });
    await advance(5000);
    // Recusado: nenhum relato a mais e a fase não muda (PROX-59), ainda nos 60 s dos inícios de A.
    expect(server.starts()).toHaveLength(used);
    expect(after.result.current.phase).toBe('idle');
    expect(Date.now() - first).toBeLessThan(MINUTE);

    // Controle: o motor de B relata quando os inícios de A saem dos 60 s.
    await advance((server.starts().at(-1) ?? 0) + MINUTE - Date.now());
    await act(async () => {
      after.result.current.simulate(LUCAS);
      await Promise.resolve();
    });
    await advance(0);
    expect(server.sent.at(-1)?.token).toBe(LUCAS);
    expect(after.result.current.phase).toBe('confirming');
  });

  it('PROX-69: a reentrega ignorada encerra a sequência de falhas (é um 200) — volta o ritmo de 1 s, e a tela não para', async () => {
    const server = touchServer((_token, index) => {
      if (index === 0 || index === 2) return withCaio;
      return index === 1 ? offline() : EMPTY;
    });
    const { result, onCard, onReportError } = await setup({ touches: server.handler });
    const start = Date.now();
    await simulateTouch(result, CAIO);
    await advance(1000);
    await simulateTouch(result, CAIO);
    await advance(20_000);
    expect(onCard).toHaveBeenCalledTimes(1);
    const relative = server.starts().map((at) => at - start);
    // 1 s: falha (sequência); 3 s: a reentrega ignorada a encerra; 4 s: o ritmo de 1 s de novo.
    expect(relative.slice(0, 4)).toEqual([0, 1000, 3000, 4000]);
    expect(onReportError).not.toHaveBeenCalled();
  });

  it.each([
    ['saiu do Pronto (QR, Bluetooth desligado)', 1, 'leave'],
    ['saiu e voltou ao Pronto (outro período)', 1, 'back'],
    ['desmontou (saiu da aba)', 0, 'unmount'],
  ] as const)(
    'PROX-69: o cartão de um relato em voo — %s → vai para a tela %i vez(es)',
    async (_case, calls, action) => {
      const server = touchServer(() => later(2000, withCaio));
      const { radio, rerender, unmount, onCard } = await setup({ touches: server.handler });
      await touch(radio);
      await advance(300);
      if (action === 'unmount') {
        await unmount();
      } else {
        await rerender({ listening: false, scanning: true });
        if (action === 'back') await rerender({ listening: true, scanning: true });
      }
      await advance(3000);
      expect(onCard).toHaveBeenCalledTimes(calls);
      if (calls > 0) {
        const [card] = onCard.mock.calls[0] as [TouchCard];
        expect(card.person.handle).toBe('caio.r');
        expect(card.canConnect).toBe(true);
      }
    },
  );

  it('PROX-69: o cartão que a tela descarta (false) não conta como mostrado; o que ela mostra (true) conta', async () => {
    let show = false;
    const server = touchServer(() => withCaio);
    const { result, onCard } = await setup({ touches: server.handler, onCard: () => show });
    await simulateTouch(result, CAIO);
    expect(onCard).toHaveBeenCalledTimes(1);
    show = true;
    // Descartado: o relator segue, e o mesmo @ chega de novo 1 s depois e aparece.
    await advance(1000);
    expect(onCard).toHaveBeenCalledTimes(2);
    // Mostrado: agora sim conta, e o relator para.
    await advance(2000);
    await simulateTouch(result, CAIO);
    await advance(3000);
    expect(onCard).toHaveBeenCalledTimes(2);
  });
});

describe('useTouch: PROX-70, cartão atrasado, cartão sem Conectar e o aviso aos 7 s (A3-3 item 8 e A3-4)', () => {
  it('PROX-70: confirmWarnAfterMs (7 s) ≥ (janela + 2 × intervalo) × 1000 — o aviso só sai depois do último casamento possível e de mais um relato', () => {
    expect(CAL.confirmWarnAfterMs).toBe(7000);
    expect(CAL.confirmWarnAfterMs).toBeGreaterThanOrEqual(
      (PROXIMITY_TOUCH_WINDOW_S + 2 * PROXIMITY_TOUCH_REPORT_INTERVAL_S) * 1000,
    );
    // O relato continua depois do aviso, até o prazo.
    expect(CAL.confirmWarnAfterMs).toBeLessThan(CAL.reportForMs);
  });

  it.each([
    [0, true],
    [5, true],
    [10, false],
    [55, false],
  ] as const)(
    'PROX-70: pairExpiresInS %i → late %s; actionsUntil = chegada + min(55 s, pairExpiresInS × 1000)',
    async (pairExpiresInS, late) => {
      const item = touchItem(nearbyPerson({ token: CAIO }), pairExpiresInS);
      const { result, onCard } = await setup({
        touches: { status: 200, body: { items: [item] } },
      });
      await simulateTouch(result, CAIO);
      const [card] = onCard.mock.calls[0] as [TouchCard];
      expect(card.late).toBe(late);
      expect(card.actionsUntil - card.matchedAt).toBe(Math.min(cardTtlMs(), pairExpiresInS * 1000));
      expect(card.person).not.toHaveProperty('pairExpiresInS');
    },
  );

  it('PROX-70: canConnect só quando o rótulo é o token relatado; o cartão devido com o token nunca emitido (A2-2) vem sem Conectar', async () => {
    const caio = touchItem(nearbyPerson({ token: CAIO }));
    // O cartão devido de Marcos, entregue no relato de outro token, com o rótulo nunca emitido.
    const marcos = touchItem(
      nearbyPerson({ token: 'NuncaEmitidoTok1', handle: 'marcos', name: 'Marcos Lima' }),
    );
    const { result, onCard } = await setup({
      touches: ({ body }) => {
        const [token] = (body as { tokens: string[] }).tokens;
        return { status: 200, body: { items: [token === CAIO ? caio : marcos] } };
      },
    });
    await simulateTouch(result, CAIO);
    await advance(1000);
    await simulateTouch(result, TX);
    expect(onCard).toHaveBeenCalledTimes(2);
    const [[first], [second]] = onCard.mock.calls as [[TouchCard], [TouchCard]];
    expect(first.canConnect).toBe(true);
    expect(second.person.handle).toBe('marcos');
    expect(second.canConnect).toBe(false);
  });
});
