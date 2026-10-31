import type { NearbyPerson } from '@sussurro/shared';
import { userEvent } from '@testing-library/react-native';
import { act, screen } from 'expo-router/testing-library';
import { AccessibilityInfo } from 'react-native';

import { COPY } from './copy';
import * as haptics from './haptics';
import { connectTiming } from './timing';
import { TOUCH_CALIBRATION } from './touch-calibration';
import type * as UseTouchModule from './useTouch';
import { resetTouchReportGate, type TouchCard } from './useTouch';
import {
  createFakeRadio,
  type FakeRadio,
} from '../../../modules/sussurro-proximity/src/fake-radio';
import {
  BIA_TOKEN,
  CAIO_TOKEN,
  configureConnect,
  mutualTouches,
  nearbyPerson,
} from '../../test-utils/connect-fixtures';
import { personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';

// ux.md §11.15 ("Outro cartão na tela") e §11.17 (casos 1 e 6): um 2º cartão com um cartão na tela
// (PROX-69, docs/equipe/testes.md §6.5).
//
// O motor de verdade não entrega esse 2º cartão: com o cartão na tela, nada é relatado (P8), e há um
// relato por vez no processo. A tela trata o caso assim mesmo (`placeCard`), então o teste entrega o
// 2º cartão pelo mesmo `onCard` que a tela passou ao motor. O `useTouch` continua o de verdade: o
// invólucro abaixo só guarda o `onCard` de cada render.

/** O `onCard` que a tela passou ao `useTouch` no último render. */
const mockEngine: { onCard: ((card: TouchCard) => boolean) | null } = { onCard: null };

jest.mock('./useTouch', () => {
  const actual = jest.requireActual<typeof UseTouchModule>('./useTouch');
  return {
    ...actual,
    useTouch: (options: Parameters<typeof UseTouchModule.useTouch>[0]) => {
      mockEngine.onCard = options.onCard;
      return actual.useTouch(options);
    },
  };
});

const SAVED_TIMING = { ...connectTiming };
const CAL = TOUCH_CALIBRATION;
const CAIO = nearbyPerson();
const BIA = nearbyPerson({ token: BIA_TOKEN, handle: 'bia.alves', name: 'Bianca Alves' });
const CARD_TTL_MS = 55_000;
/** O `getCapabilities` do Verificando que demora (o iPhone recriando o gerenciador do Bluetooth). */
const SLOW_CAPABILITIES_MS = 400;

const announce = jest.mocked(AccessibilityInfo.announceForAccessibility);
const queued = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
const focus = jest.mocked(AccessibilityInfo.sendAccessibilityEvent);

let vibrate: jest.SpyInstance;

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function afterFocus() {
  return connectTiming.focusDelayMs + connectTiming.announceAfterFocusMs;
}

/** O `testID` de cada elemento que recebeu o foco, na ordem. */
function focusedTestIds(): unknown[] {
  return focus.mock.calls.map(
    ([target]) => (target as unknown as { props?: { testID?: unknown } }).props?.testID,
  );
}

/** A ordem global (`invocationCallOrder`) do único anúncio em fila de `message`. */
function queuedOrder(message: string): number {
  const orders = queued.mock.calls.flatMap(([text, options], index) =>
    text === message ? [{ options, order: queued.mock.invocationCallOrder[index] ?? 0 }] : [],
  );
  expect(orders).toHaveLength(1);
  expect(orders[0]?.options).toEqual({ queue: true });
  expect(announce).not.toHaveBeenCalledWith(message);
  return orders[0]?.order ?? 0;
}

/** A ordem global do 1º foco em `testId`. */
function focusOrder(testId: string): number {
  const index = focusedTestIds().indexOf(testId);
  expect(index).toBeGreaterThanOrEqual(0);
  return focus.mock.invocationCallOrder[index] ?? Infinity;
}

async function touch(radio: FakeRadio, token = CAIO_TOKEN) {
  for (let elapsed = 0; elapsed < 1400; elapsed += CAL.sightingMinIntervalMs) {
    await act(async () => {
      radio.emitSighting(token, CAL.advertiserTxDbm - 30);
      await jest.advanceTimersByTimeAsync(CAL.sightingMinIntervalMs);
    });
  }
}

function slowCapabilities(radio: FakeRadio) {
  radio.getCapabilities = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ ...radio.capabilities });
      }, SLOW_CAPABILITIES_MS);
    });
}

/** Abre o Conectar, encosta em Caio e espera o cartão dele (o 11). */
async function openCaioCard() {
  const radio = createFakeRadio();
  const rendered = await renderApp({
    signedInAs: personalMe(),
    initialUrl: '/pessoal/conectar',
    radio,
    configure: (fake) => {
      configureConnect(fake);
      fake.on('POST /v1/proximity/touches', mutualTouches({ [CAIO_TOKEN]: CAIO }));
    },
  });
  expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  await touch(radio);
  expect(await screen.findByRole('header', { name: CAIO.name })).toBeOnTheScreen();
  expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
  return { ...rendered, radio, cardAt: Date.now() };
}

/** O cartão de `person` como o motor o entregaria agora (`pairExpiresInS` 55: o 11 comum). */
function cardNow(person: NearbyPerson): TouchCard {
  const now = Date.now();
  return { person, matchedAt: now, actionsUntil: now + CARD_TTL_MS, late: false, canConnect: true };
}

/** Entrega um 2º cartão pelo `onCard` da tela: `true` mostrado ou guardado; `false` descartado. */
async function deliver(card: TouchCard): Promise<boolean> {
  const { onCard } = mockEngine;
  if (onCard === null) throw new Error('a tela ainda não montou o useTouch');
  let shown = false;
  await act(async () => {
    shown = onCard(card);
    await Promise.resolve();
  });
  return shown;
}

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, tickMs: 20 });
  resetTouchReportGate();
  mockEngine.onCard = null;
  announce.mockClear();
  queued.mockClear();
  focus.mockClear();
  vibrate = jest.spyOn(haptics, 'vibrate').mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('Conectar: outro cartão com um cartão na tela (ux.md §11.15 e §11.17, casos 1 e 6; PROX-69)', () => {
  it('PROX-69 (caso 1): o cartão da mesma pessoa do cartão na tela é descartado — a tela não muda, nada vibra nem é lido de novo, e ele não aparece depois de "Cancelar"', async () => {
    await openCaioCard();
    await advance(afterFocus());
    focus.mockClear();
    queued.mockClear();
    expect(await deliver(cardNow(CAIO))).toBe(false);
    await advance(afterFocus());
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(focusedTestIds()).toEqual([]);
    expect(queued).not.toHaveBeenCalled();
    expect(vibrate.mock.calls).toEqual([['touched']]);
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(1000);
    expect(screen.queryByTestId('conectar-encostado')).toBeNull();
    expect(vibrate.mock.calls).toEqual([['touched']]);
  });

  it('PROX-69 (outro cartão na tela): o de outra pessoa espera, sem vibrar nem ser lido; "Cancelar" no da tela → o que esperava aparece direto, sem passar pelo Pronto, com o foco no nome e o A3 depois, sem Toast', async () => {
    await openCaioCard();
    await advance(afterFocus());
    expect(await deliver(cardNow(BIA))).toBe(true);
    await advance(afterFocus());
    expect(screen.getByRole('header', { name: CAIO.name })).toBeOnTheScreen();
    expect(screen.queryByRole('header', { name: BIA.name })).toBeNull();
    expect(vibrate.mock.calls).toEqual([['touched']]);
    expect(queued).not.toHaveBeenCalledWith(COPY.announceTouched(BIA.name), expect.anything());
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: BIA.name })).toBeOnTheScreen();
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(screen.queryByTestId('conectar-titulo')).toBeNull();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expect(focusOrder('cartao-nome')).toBeLessThan(queuedOrder(COPY.announceTouched(BIA.name)));
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(vibrate.mock.calls).toEqual([['touched'], ['touched']]);
  });

  it.each([
    ['o 11', 30_000, 'conectar-encostado', COPY.announceTouched(BIA.name)],
    [
      'o 21 (faltam menos de 10 s para o par de Bia)',
      1_000,
      'conectar-encostado-atrasado',
      COPY.lateCardText('Bianca'),
    ],
  ] as const)(
    'PROX-69 (caso 6, C2): com o cartão de Bia esperando, o de Caio vence com o Verificando lento; o de Bia aparece na hora, como %s, sem esperar a conferência, e o T20 de Caio sai já — no leitor de tela, o foco no nome de Bia, o T20 e o anúncio de Bia, nessa ordem',
    async (_case, deliverAfterMs, testID, cardAnnouncement) => {
      const { radio, cardAt } = await openCaioCard();
      slowCapabilities(radio);
      await advance(cardAt + deliverAfterMs - Date.now());
      expect(await deliver(cardNow(BIA))).toBe(true);
      await advance(afterFocus());
      expect(screen.getByRole('header', { name: CAIO.name })).toBeOnTheScreen();
      expect(screen.queryByRole('header', { name: BIA.name })).toBeNull();
      focus.mockClear();
      queued.mockClear();
      announce.mockClear();
      // O cartão de Caio vence (17). Bia aparece antes de o `getCapabilities` lento (400 ms) voltar.
      await advance(cardAt + CARD_TTL_MS + 100 - Date.now());
      expect(screen.getByRole('header', { name: BIA.name })).toBeOnTheScreen();
      expect(screen.getByTestId(testID)).toBeOnTheScreen();
      expect(screen.queryByTestId('conectar-verificando')).toBeNull();
      expect(screen.getByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
      await advance(afterFocus());
      expect(focusedTestIds()).toEqual(['cartao-nome']);
      const focusedAt = focusOrder('cartao-nome');
      const t20At = queuedOrder(COPY.cardExpired('Caio'));
      const biaAnnouncedAt = queuedOrder(cardAnnouncement);
      expect(focusedAt).toBeLessThan(t20At);
      expect(t20At).toBeLessThan(biaAnnouncedAt);
      expect(vibrate.mock.calls).toEqual([['touched'], ['touched']]);
      // A conferência lenta que foi cancelada não troca o cartão de Bia pelo Pronto.
      await advance(SLOW_CAPABILITIES_MS);
      expect(screen.getByTestId(testID)).toBeOnTheScreen();
    },
  );
});
