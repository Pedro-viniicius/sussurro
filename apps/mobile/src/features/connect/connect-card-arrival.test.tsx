import {
  type ConnectionRequest,
  type NearbyPerson,
  proximityQrPayload,
  type ProximityTouchItem,
} from '@sussurro/shared';
import { fireEvent, userEvent } from '@testing-library/react-native';
import { act, screen, waitFor, within } from 'expo-router/testing-library';
import {
  AccessibilityInfo,
  Alert,
  type AlertButton,
  AppState,
  type AppStateStatus,
  Linking,
} from 'react-native';

import { COPY } from './copy';
import * as haptics from './haptics';
import { connectTiming } from './timing';
import { TOUCH_CALIBRATION } from './touch-calibration';
import { resetTouchReportGate } from './useTouch';
import {
  createFakeRadio,
  type FakeRadio,
} from '../../../modules/sussurro-proximity/src/fake-radio';
import { cameraMock } from '../../test-utils/camera-mock';
import {
  apiError,
  BIA_TOKEN,
  CAIO_TOKEN,
  configureConnect,
  connectionRequest,
  incomingRequest,
  mutualTouches,
  nearbyPerson,
  touchItem,
} from '../../test-utils/connect-fixtures';
import { type FakeApi, type FakeReply, personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';
import { blockedMessage } from '../moderation/useBlockAccount';
import { PROFILE_GONE_MESSAGE } from '../relations/useFollowToggle';

// ux.md §11.15 (ADR 0012, Adendo A3): o cartão atrasado (21), o cartão sem Conectar (22), o cartão
// que chega fora do Pronto, a saída do cartão e o Bluetooth com o cartão na tela (PROX-69 e PROX-70,
// docs/equipe/testes.md §6.5).

const SAVED_TIMING = { ...connectTiming };
const CAL = TOUCH_CALIBRATION;
const TX_REF = CAL.advertiserTxDbm;
const CAIO = nearbyPerson();
const BIA = nearbyPerson({ token: BIA_TOKEN, handle: 'bia.alves', name: 'Bianca Alves' });
const HELENA = nearbyPerson({ handle: 'helena', name: 'Helena Souza' });
const NEVER_ISSUED = 'NeverIssuedTok01';
const CARD_TTL_MS = 55_000;
/** O pedido por QR de A para Caio (o 13 do QR). */
const QR_REQUEST = connectionRequest({ method: 'qr' });

const announce = jest.mocked(AccessibilityInfo.announceForAccessibility);
const queued = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
const focus = jest.mocked(AccessibilityInfo.sendAccessibilityEvent);

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

/** ux.md §11.8: primeiro o foco (em `focusedTestId`), depois o anúncio, em fila, uma vez só. */
function expectAnnouncedAfterFocus(message: string, focusedTestId: string) {
  const calls = queued.mock.calls.flatMap(([text, options], index) =>
    text === message ? [{ options, order: queued.mock.invocationCallOrder[index] ?? 0 }] : [],
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.options).toEqual({ queue: true });
  const announcedAt = calls[0]?.order ?? 0;
  const focusedAt = focusedTestIds().flatMap((testId, index) =>
    testId === focusedTestId ? [focus.mock.invocationCallOrder[index] ?? Infinity] : [],
  );
  expect(focusedAt.some((order) => order < announcedAt)).toBe(true);
  expect(announce).not.toHaveBeenCalledWith(message);
}

/** Nada do cartão saiu ainda: nem o foco no nome, nem o anúncio, nem a vibração. */
function expectNoCardCue(message: string) {
  expect(focusedTestIds()).not.toContain('cartao-nome');
  expect(queued).not.toHaveBeenCalledWith(message, expect.anything());
  expect(vibrate).not.toHaveBeenCalledWith('touched');
}

async function touch(radio: FakeRadio, token = CAIO_TOKEN) {
  for (let elapsed = 0; elapsed < 1400; elapsed += CAL.sightingMinIntervalMs) {
    await act(async () => {
      radio.emitSighting(token, TX_REF - 30);
      await jest.advanceTimersByTimeAsync(CAL.sightingMinIntervalMs);
    });
  }
}

/** Resposta depois de `ms` (relógio falso). */
function later(ms: number, reply: FakeReply): Promise<FakeReply> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(reply);
    }, ms);
  });
}

/**
 * `touches` com um relato em voo: o 1º relato responde só depois de `delayMs` (dentro do prazo de
 * 4 s), com o cartão; os seguintes, `[]`. Dá tempo de a pessoa sair do Pronto antes da resposta.
 */
function cardInFlight(item: NearbyPerson | ProximityTouchItem, delayMs = 3000) {
  let calls = 0;
  return (): FakeReply | Promise<FakeReply> => {
    calls += 1;
    if (calls > 1) return { status: 200, body: { items: [] } };
    return later(delayMs, { status: 200, body: { items: [touchItem(item)] } });
  };
}

function captureAppState() {
  const listeners: ((state: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') listeners.push(listener);
    return { remove: () => undefined };
  });
  return async (state: AppStateStatus) => {
    await act(async () => {
      for (const listener of listeners) listener(state);
      await Promise.resolve();
    });
  };
}

/** Responde ao `Alert` de "Bloquear @…?" apertando o botão pedido. */
function captureAlert() {
  const alerts: { buttons: AlertButton[] }[] = [];
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    alerts.push({ buttons: buttons ?? [] });
  });
  return async (text: string) => {
    const button = alerts.at(-1)?.buttons.find((candidate) => candidate.text === text);
    expect(button).toBeDefined();
    await act(async () => {
      button?.onPress?.();
      await Promise.resolve();
    });
  };
}

/** O QR (o `resolve` acha Caio) e o pedido por QR para Caio (o 13). */
function configureQr(
  fake: FakeApi,
  options: {
    resolve?: () => FakeReply | Promise<FakeReply>;
    created?: ConnectionRequest;
  } = {},
) {
  fake.on(
    'POST /v1/proximity/resolve',
    options.resolve ?? { status: 200, body: { items: [CAIO] } },
  );
  fake.on('POST /v1/connections/requests', { status: 201, body: options.created ?? QR_REQUEST });
  fake.on(`GET /v1/connections/requests/${QR_REQUEST.id}`, { status: 200, body: QR_REQUEST });
  fake.on(`DELETE /v1/connections/requests/${QR_REQUEST.id}`, {
    status: 200,
    body: { ...QR_REQUEST, status: 'cancelled' },
  });
}

async function openReady(options: { radio?: FakeRadio; configure?: (api: FakeApi) => void } = {}) {
  const radio = options.radio ?? createFakeRadio();
  const rendered = await renderApp({
    signedInAs: personalMe(),
    initialUrl: '/pessoal/conectar',
    radio,
    configure: (fake) => {
      configureConnect(fake);
      fake.on('POST /v1/me/blocks', { status: 204 });
      fake.on('POST /v1/reports', { status: 202 });
      options.configure?.(fake);
    },
  });
  expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  await waitFor(() => {
    expect(radio.scanning).toBe(true);
  });
  return { ...rendered, radio };
}

/** Abre o Conectar, encosta e espera o cartão de `item` (o 2º relato traz o cartão). */
async function openCard(item: NearbyPerson | ProximityTouchItem, extra?: (api: FakeApi) => void) {
  const opened = await openReady({
    configure: (fake) => {
      fake.on('POST /v1/proximity/touches', mutualTouches({ [CAIO_TOKEN]: item }));
      extra?.(fake);
    },
  });
  await touch(opened.radio);
  expect(await screen.findByRole('header', { name: item.name })).toBeOnTheScreen();
  return { ...opened, cardAt: Date.now() };
}

async function toQr() {
  await userEvent.press(screen.getByRole('radio', { name: 'QR code' }));
  expect(await screen.findByTestId('conectar-qr')).toBeOnTheScreen();
}

async function openCamera() {
  await userEvent.press(screen.getByRole('button', { name: COPY.readTheirCode }));
  expect(await screen.findByTestId('qr-camera')).toBeOnTheScreen();
}

async function scan(data: string) {
  const camera = await screen.findByTestId('qr-camera');
  await fireEvent(camera, 'barcodeScanned', { data });
}

let vibrate: jest.SpyInstance;

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, tickMs: 20 });
  resetTouchReportGate();
  cameraMock.reset();
  announce.mockClear();
  queued.mockClear();
  focus.mockClear();
  vibrate = jest.spyOn(haptics, 'vibrate').mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('Conectar: cartão atrasado (estado 21; ux.md §11.15; PROX-70)', () => {
  it.each([0, 5])(
    'PROX-70 (pairExpiresInS %i): sem Conectar, sem ‹Cancelar› e sem a linha; o T47 e o (Voltar); foco no nome e o T47 depois, em fila; a vibração do cartão; não vence, sem o T20 e sem tela acesa; "Voltar" → Pronto, com o foco no título e sem Toast',
    async (pairExpiresInS) => {
      const { radio, api } = await openCard(touchItem(CAIO, pairExpiresInS));
      expect(screen.getByTestId('conectar-encostado-atrasado')).toBeOnTheScreen();
      expect(screen.getByText('@caio.r')).toBeOnTheScreen();
      expect(screen.getByText(COPY.lateCardText('Caio'))).toBeOnTheScreen();
      expect(screen.queryByText('Conectar com Caio')).toBeNull();
      expect(screen.queryByRole('button', { name: COPY.cancel })).toBeNull();
      expect(screen.queryByTestId('cartao-denunciar')).toBeNull();
      expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
      // Sem a introdução e sem o seletor.
      expect(screen.queryByRole('radio', { name: 'Encostar' })).toBeNull();
      expect(vibrate.mock.calls).toEqual([['touched']]);
      await advance(afterFocus());
      expect(focusedTestIds()).toEqual(['cartao-nome']);
      expectAnnouncedAfterFocus(COPY.lateCardText('Caio'), 'cartao-nome');
      await waitFor(() => {
        expect(radio.keepScreenOn).toBe(false);
      });
      focus.mockClear();
      await advance(60_000);
      expect(screen.getByTestId('conectar-encostado-atrasado')).toBeOnTheScreen();
      expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
      expect(queued).not.toHaveBeenCalledWith(COPY.cardExpired('Caio'), expect.anything());
      expect(radio.keepScreenOn).toBe(false);
      expect(focusedTestIds()).toEqual([]);
      await userEvent.press(screen.getByRole('button', { name: COPY.back }));
      expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
      await advance(afterFocus());
      expect(focusedTestIds()).toEqual(['conectar-titulo']);
      expect(screen.queryByTestId('toast')).toBeNull();
      expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
    },
  );

  it('PROX-70 (21 com pedido já pendente): aparece o 14, sem a linha; Aceitar e Recusar seguem o prazo do pedido, além do fim do par; no fim do pedido, Pronto + "O pedido de Helena expirou."', async () => {
    const request = incomingRequest({ expiresInS: 70 });
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on(
          'POST /v1/proximity/touches',
          mutualTouches({ [CAIO_TOKEN]: touchItem(HELENA, 0) }),
        );
        fake.on('GET /v1/connections/requests/incoming', {
          status: 200,
          body: { items: [request] },
        });
      },
    });
    await touch(radio);
    expect(await screen.findByTestId('conectar-pedido-cartao')).toBeOnTheScreen();
    const cardAt = Date.now();
    expect(screen.getByRole('header', { name: 'Helena quer se conectar' })).toBeOnTheScreen();
    expect(screen.queryByTestId('folha-pedido')).toBeNull();
    expect(screen.queryByTestId('cartao-denunciar', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId('cartao-bloquear', { includeHiddenElements: true })).toBeNull();
    await advance(cardAt + 60_000 - Date.now());
    expect(screen.getByRole('button', { name: COPY.accept })).toBeEnabled();
    expect(screen.getByRole('button', { name: COPY.decline })).toBeEnabled();
    await advance(15_000);
    expect(await screen.findByText(COPY.expired('Helena'))).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  });

  it('PROX-70 (21 → 14): com o 21 na tela, o pedido da mesma pessoa o transforma no 14, com a vibração leve e o A5 depois do foco no título', async () => {
    const request = incomingRequest();
    let pending = false;
    await openCard(touchItem(HELENA, 5), (fake) => {
      fake.on('GET /v1/connections/requests/incoming', () => ({
        status: 200,
        body: { items: pending ? [request] : [] },
      }));
    });
    expect(screen.getByTestId('conectar-encostado-atrasado')).toBeOnTheScreen();
    await advance(afterFocus());
    focus.mockClear();
    pending = true;
    expect(await screen.findByTestId('conectar-pedido-cartao')).toBeOnTheScreen();
    expect(vibrate).toHaveBeenCalledWith('incoming');
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-titulo']);
    expectAnnouncedAfterFocus(COPY.announceIncoming('Helena'), 'cartao-titulo');
    expect(screen.queryByTestId('cartao-denunciar', { includeHiddenElements: true })).toBeNull();
  });

  it('PROX-70 (21 de quem já é conexão): aparece o 12, com a linha', async () => {
    await openCard(touchItem(nearbyPerson({ alreadyConnected: true }), 0));
    expect(screen.getByTestId('conectar-encostado-conectados')).toBeOnTheScreen();
    expect(screen.getByText(COPY.alreadyConnected)).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-denunciar')).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-bloquear')).toBeOnTheScreen();
  });

  it('PROX-70 (21, segundo plano): na volta, o 21 está igual — sem o T20, sem vencer e sem relatar nada com ele na tela (P8)', async () => {
    const setAppState = captureAppState();
    const { api } = await openCard(touchItem(CAIO, 5));
    expect(screen.getByTestId('conectar-encostado-atrasado')).toBeOnTheScreen();
    const reports = api.callsTo('POST /v1/proximity/touches').length;
    await setAppState('background');
    await advance(70_000);
    await setAppState('active');
    await advance(afterFocus());
    expect(screen.getByTestId('conectar-encostado-atrasado')).toBeOnTheScreen();
    expect(screen.getByText(COPY.lateCardText('Caio'))).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.back })).toBeEnabled();
    expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
    expect(queued).not.toHaveBeenCalledWith(COPY.cardExpired('Caio'), expect.anything());
    expect(api.callsTo('POST /v1/proximity/touches')).toHaveLength(reports);
  });

  it('PROX-70 (pairExpiresInS 10): o 11 de sempre, com as ações por 10 s, e o 17 com o T20', async () => {
    const { cardAt } = await openCard(touchItem(CAIO, 10));
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(screen.getByText('Conectar com Caio')).toBeOnTheScreen();
    await advance(cardAt + 10_000 - 500 - Date.now());
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    await advance(1000);
    expect(await screen.findByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  });

  it.each([
    [6_500, true],
    [7_500, false],
  ] as const)(
    'PROX-70 (pairExpiresInS 10, M7): "Bloquear" confirmado %i ms depois do cartão → chama a API: %s (o ‹Bloquear› vale até os 7 s)',
    async (at, calls) => {
      const pressAlert = captureAlert();
      const { api, cardAt } = await openCard(touchItem(CAIO, 10));
      await userEvent.press(screen.getByTestId('cartao-bloquear'));
      await advance(cardAt + at - Date.now());
      await pressAlert('Bloquear');
      if (calls) {
        expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
        expect(api.callsTo('POST /v1/me/blocks')).toHaveLength(1);
        return;
      }
      expect(await screen.findByText(PROFILE_GONE_MESSAGE)).toBeOnTheScreen();
      expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
      expect(api.callsTo('POST /v1/me/blocks')).toHaveLength(0);
    },
  );
});

describe('Conectar: cartão sem Conectar (estado 22; ux.md §11.15; PROX-70)', () => {
  const NO_CONNECT = nearbyPerson({ token: NEVER_ISSUED });

  it('PROX-70: o T48 com o primeiro nome, o (Voltar) e a linha; o foco no nome e o T48 depois (A8); a tela acesa; no actionsUntil, o 17 com o T20; nenhum pedido sai com esse token', async () => {
    const { radio, api, cardAt } = await openCard(NO_CONNECT);
    expect(screen.getByTestId('conectar-encostado-sem-conectar')).toBeOnTheScreen();
    expect(screen.getByText(COPY.noConnectCardText('Caio'))).toBeOnTheScreen();
    expect(screen.queryByText(COPY.cardCheck)).toBeNull();
    expect(screen.queryByText('Conectar com Caio')).toBeNull();
    expect(screen.queryByRole('button', { name: COPY.cancel })).toBeNull();
    const card = within(screen.getByTestId('conectar-encostado-sem-conectar'));
    expect(
      card.getAllByRole('button').map((node) => String(node.props.accessibilityLabel)),
    ).toEqual([COPY.back, 'Denunciar', 'Bloquear']);
    expect(vibrate.mock.calls).toEqual([['touched']]);
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expectAnnouncedAfterFocus(COPY.noConnectCardText('Caio'), 'cartao-nome');
    expect(radio.keepScreenOn).toBe(true);
    await advance(cardAt + CARD_TTL_MS - 1000 - Date.now());
    expect(screen.getByTestId('cartao-bloquear')).toBeOnTheScreen();
    focus.mockClear();
    await advance(1500);
    expect(await screen.findByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(afterFocus());
    expectAnnouncedAfterFocus(COPY.cardExpired('Caio'), 'conectar-titulo');
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });

  it('PROX-70: ‹Bloquear› com 204 → o Bloqueado (M4); ‹Denunciar› no 22 → o formulário com o T46', async () => {
    const pressAlert = captureAlert();
    const { api } = await openCard(NO_CONNECT);
    await userEvent.press(screen.getByTestId('cartao-denunciar'));
    expect(await screen.findByTestId('conectar-denunciar')).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('conectar-denunciar')).getByText(COPY.reportDeadline),
    ).toBeOnTheScreen();
    await userEvent.press(
      within(screen.getByTestId('conectar-denunciar')).getByRole('button', { name: 'Cancelar' }),
    );
    await advance(connectTiming.formDismissFallbackMs);
    expect(screen.getByTestId('conectar-encostado-sem-conectar')).toBeOnTheScreen();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await pressAlert('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    expect(screen.getByText(blockedMessage('caio.r'))).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/me/blocks').map((call) => call.body)).toEqual([
      { handle: 'caio.r' },
    ]);
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });
});

describe('Conectar: cartão que chega fora do Pronto (ux.md §11.15; PROX-69)', () => {
  it('PROX-69 (QR com o meu código): o cartão entra no lugar do QR, sem o seletor; "Cancelar" → o Pronto, com o seletor em "Encostar" e o foco no título, nunca de volta ao QR', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(CAIO));
      },
    });
    await touch(radio);
    await toQr();
    await advance(3000);
    expect(await screen.findByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(screen.queryByTestId('conectar-qr')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'QR code' })).toBeNull();
    expect(vibrate.mock.calls).toEqual([['touched']]);
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expectAnnouncedAfterFocus(COPY.announceTouched('Caio Ribeiro'), 'cartao-nome');
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Encostar' })).toBeChecked();
    expect(screen.queryByTestId('conectar-qr')).toBeNull();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['conectar-titulo']);
  });

  it('PROX-69 (câmera aberta, sem leitura): a câmera fecha e o cartão aparece; no iOS, o foco, o anúncio e a vibração esperam o onDismiss do Modal', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(CAIO));
      },
    });
    await touch(radio);
    await toQr();
    await openCamera();
    const { onDismiss } = screen.getByTestId('conectar-camera').props as {
      onDismiss: () => void;
    };
    // Em passos curtos, para o cartão ser desenhado logo que chega (a folga conta da chegada).
    expect(
      await screen.findByTestId('conectar-encostado', {}, { timeout: 5000 }),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
    await advance(afterFocus());
    expectNoCardCue(COPY.announceTouched('Caio Ribeiro'));
    await act(async () => {
      onDismiss();
      await Promise.resolve();
    });
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expectAnnouncedAfterFocus(COPY.announceTouched('Caio Ribeiro'), 'cartao-nome');
    expect(vibrate.mock.calls).toEqual([['touched']]);
    // A saída volta ao Encostar, nunca à câmera.
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('PROX-69 (câmera aberta, sem o onDismiss): o cartão recebe o foco depois da folga de segurança', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(CAIO));
      },
    });
    await touch(radio);
    await toQr();
    await openCamera();
    expect(
      await screen.findByTestId('conectar-encostado', {}, { timeout: 5000 }),
    ).toBeOnTheScreen();
    await advance(afterFocus());
    expectNoCardCue(COPY.announceTouched('Caio Ribeiro'));
    await advance(connectTiming.cameraDismissFallbackMs);
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expectAnnouncedAfterFocus(COPY.announceTouched('Caio Ribeiro'), 'cartao-nome');
  });

  it('PROX-69 (câmera com uma leitura em andamento): o cartão espera o resultado; a tela volta ao QR com a câmera (código inválido) e aí o cartão aparece, com a câmera fechando', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(BIA));
        configureQr(fake, {
          resolve: () => later(4000, { status: 200, body: { items: [] } }),
        });
      },
    });
    await touch(radio, BIA_TOKEN);
    await toQr();
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    await advance(3000);
    // O cartão chegou, mas a leitura ainda está em andamento: a câmera fica, sem o cartão.
    expect(screen.getByTestId('qr-scanner')).toBeOnTheScreen();
    expect(screen.queryByTestId('conectar-encostado')).toBeNull();
    expect(vibrate).not.toHaveBeenCalledWith('touched');
    await advance(1500);
    expect(await screen.findByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Bianca Alves' })).toBeOnTheScreen();
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('PROX-69 (Bluetooth desligado, 4): o foco vai ao título do EmptyState; o EmptyState sai e o cartão entra; "Cancelar" com o Bluetooth ainda desligado → o 4, com o foco no título do EmptyState', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(CAIO));
      },
    });
    await touch(radio);
    await act(async () => {
      radio.emitState('off');
      await Promise.resolve();
    });
    expect(await screen.findByTestId('bt-desligado')).toBeOnTheScreen();
    // O Bluetooth desligou sozinho no Pronto: o Pronto saiu inteiro da tela, e o foco vai ao título
    // do EmptyState (ux.md §11.17, C1).
    await advance(1000);
    expect(focusedTestIds()).toEqual(['bt-desligado-titulo']);
    await advance(2000);
    expect(await screen.findByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(screen.queryByTestId('bt-desligado')).toBeNull();
    // Fora do Pronto, sem varredura nova (no iOS, ela pediria a permissão sem a explicação).
    expect(radio.scanning).toBe(false);
    await advance(afterFocus());
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: COPY.btOffTitle })).toBeOnTheScreen();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['bt-desligado-titulo']);
  });

  it('PROX-69 (o celular deixou de anunciar, 5): o foco vai à faixa T30; o cartão entra no QR com a faixa; a saída vai ao QR, com a faixa e o foco nela', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(CAIO));
      },
    });
    await touch(radio);
    await act(async () => {
      radio.emitError({ operation: 'advertise', code: 'unsupported' });
      await Promise.resolve();
    });
    expect(await screen.findByText(COPY.unsupportedBanner)).toBeOnTheScreen();
    // O Pronto saiu sozinho da tela: o foco vai à faixa T30 (ux.md §11.17, C1).
    await advance(1000);
    expect(focusedTestIds()).toEqual(['conectar-sem-suporte-faixa']);
    await advance(2000);
    expect(await screen.findByTestId('conectar-encostado')).toBeOnTheScreen();
    await advance(afterFocus());
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByTestId('conectar-sem-suporte-faixa')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'QR code' })).toBeChecked();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['conectar-sem-suporte-faixa']);
  });

  it('PROX-69 (Aguardando, 13, da mesma pessoa): o cartão é descartado; "Cancelar pedido" volta ao QR, sem o cartão', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(CAIO));
        configureQr(fake);
      },
    });
    await touch(radio);
    await toQr();
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    expect(await screen.findByTestId('conectar-aguardando')).toBeOnTheScreen();
    await advance(3000);
    expect(screen.getByTestId('conectar-aguardando')).toBeOnTheScreen();
    expect(screen.queryByTestId('conectar-encostado')).toBeNull();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancelRequest }));
    expect(await screen.findByTestId('conectar-qr')).toBeOnTheScreen();
    await advance(1000);
    expect(screen.queryByTestId('conectar-encostado')).toBeNull();
    expect(vibrate).not.toHaveBeenCalledWith('touched');
  });

  it('PROX-69 (Aguardando, 13, de outra pessoa): o cartão espera e aparece depois de "Cancelar pedido" — como o 21, se faltam menos de 10 s', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(touchItem(BIA, 15)));
        configureQr(fake);
      },
    });
    await touch(radio, BIA_TOKEN);
    await toQr();
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    expect(await screen.findByTestId('conectar-aguardando')).toBeOnTheScreen();
    await advance(3000);
    // O cartão de Bia chegou: o 13 não muda.
    expect(screen.getByTestId('conectar-aguardando')).toBeOnTheScreen();
    expect(screen.queryByRole('header', { name: 'Bianca Alves' })).toBeNull();
    expect(vibrate).not.toHaveBeenCalledWith('touched');
    // Depois de 6 s, faltam 9 s do par: aparece atrasado.
    await advance(6000);
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancelRequest }));
    expect(await screen.findByTestId('conectar-encostado-atrasado')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Bianca Alves' })).toBeOnTheScreen();
    expect(vibrate).toHaveBeenCalledWith('touched');
    await advance(afterFocus());
    expect(focusedTestIds()).toContain('cartao-nome');
    expectAnnouncedAfterFocus(COPY.lateCardText('Bianca'), 'cartao-nome');
  });

  it.each([
    ['Conectados (15)', 'accepted', 'conectar-conectados', COPY.connectAnother],
    ['Não confirmado (16)', 'not_confirmed', 'conectar-nao-confirmou', COPY.tryAgain],
  ] as const)(
    'PROX-69 (%s, de outra pessoa): o cartão espera e aparece pelo botão "%s"',
    async (_case, status, testID, button) => {
      const { radio } = await openReady({
        configure: (fake) => {
          fake.on('POST /v1/proximity/touches', cardInFlight(BIA));
          configureQr(fake, { created: { ...QR_REQUEST, status } });
        },
      });
      await touch(radio, BIA_TOKEN);
      await toQr();
      await openCamera();
      await scan(proximityQrPayload(CAIO_TOKEN));
      expect(await screen.findByTestId(testID)).toBeOnTheScreen();
      await advance(3000);
      expect(screen.getByTestId(testID)).toBeOnTheScreen();
      expect(screen.queryByRole('header', { name: 'Bianca Alves' })).toBeNull();
      await userEvent.press(screen.getByRole('button', { name: button }));
      expect(await screen.findByRole('header', { name: 'Bianca Alves' })).toBeOnTheScreen();
      expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    },
  );

  it('PROX-69 (tela parada, 18 a 20): o cartão é descartado; "Tentar de novo" volta sem ele', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(BIA));
        configureQr(fake, { resolve: () => apiError(429, 'RATE_LIMITED') });
      },
    });
    await touch(radio, BIA_TOKEN);
    await toQr();
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    expect(await screen.findByRole('header', { name: COPY.pausedTitle })).toBeOnTheScreen();
    await advance(3000);
    expect(screen.queryByRole('header', { name: 'Bianca Alves' })).toBeNull();
    await userEvent.press(screen.getByRole('button', { name: COPY.tryAgain }));
    expect(await screen.findByTestId('conectar-qr')).toBeOnTheScreen();
    await advance(1000);
    expect(screen.queryByRole('header', { name: 'Bianca Alves' })).toBeNull();
    expect(vibrate).not.toHaveBeenCalledWith('touched');
  });

  it('PROX-69 (folha do pedido de outra pessoa aberta): o cartão entra por baixo da folha; o foco, o anúncio e a vibração dele esperam a folha fechar', async () => {
    const request = incomingRequest();
    let pending = false;
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(CAIO));
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: pending ? [request] : [] },
        }));
      },
    });
    await touch(radio);
    pending = true;
    expect(await screen.findByTestId('folha-pedido')).toBeOnTheScreen();
    await advance(afterFocus());
    focus.mockClear();
    queued.mockClear();
    await advance(3000);
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(screen.getByTestId('folha-pedido')).toBeOnTheScreen();
    await advance(afterFocus());
    expectNoCardCue(COPY.announceTouched('Caio Ribeiro'));
    pending = false;
    await userEvent.press(
      within(screen.getByTestId('folha-pedido')).getByRole('button', { name: COPY.close }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId('folha-pedido')).toBeNull();
    });
    await advance(afterFocus());
    expect(focusedTestIds()).toContain('cartao-nome');
    expectAnnouncedAfterFocus(COPY.announceTouched('Caio Ribeiro'), 'cartao-nome');
    expect(vibrate).toHaveBeenCalledWith('touched');
  });

  it('PROX-69 (folha de outra pessoa, "Aceitar"): o cartão que estava por baixo e não foi visto não se perde — espera o 15 e aparece por "Conectar outra pessoa"', async () => {
    const request = incomingRequest();
    let pending = false;
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(CAIO));
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: pending ? [request] : [] },
        }));
        fake.on(`POST /v1/connections/requests/${request.id}/accept`, () => {
          pending = false;
          return { status: 200, body: { ...request, status: 'accepted', expiresInS: 0 } };
        });
      },
    });
    await touch(radio);
    pending = true;
    expect(await screen.findByTestId('folha-pedido')).toBeOnTheScreen();
    await advance(3000);
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    await userEvent.press(
      within(screen.getByTestId('folha-pedido')).getByRole('button', { name: COPY.accept }),
    );
    expect(
      await screen.findByRole('header', { name: 'Você e Helena estão conectados' }),
    ).toBeOnTheScreen();
    expect(vibrate).not.toHaveBeenCalledWith('touched');
    await userEvent.press(screen.getByRole('button', { name: COPY.connectAnother }));
    expect(await screen.findByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(vibrate).toHaveBeenCalledWith('touched');
  });

  it('PROX-69 (app em segundo plano): o cartão que chega aparece na volta, e o foco e o anúncio saem nessa hora', async () => {
    const setAppState = captureAppState();
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', cardInFlight(CAIO));
      },
    });
    await touch(radio);
    await setAppState('background');
    await advance(3000 + afterFocus());
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expectNoCardCue(COPY.announceTouched('Caio Ribeiro'));
    await setAppState('active');
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expectAnnouncedAfterFocus(COPY.announceTouched('Caio Ribeiro'), 'cartao-nome');
    expect(vibrate.mock.calls).toEqual([['touched']]);
  });

  it('PROX-69 (reentrega na tela): o mesmo @ que chega em menos de 10 s depois do cartão mostrado é ignorado (a tela segue no Pronto); aos 10 s, o cartão aparece', async () => {
    const { radio, cardAt } = await openCard(CAIO);
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    // Afastam e encostam de novo (o servidor reentrega o mesmo cartão).
    await advance(2000);
    await touch(radio);
    await advance(cardAt + CAL.cardRedeliveryMs - 1000 - Date.now());
    expect(screen.queryByTestId('conectar-encostado')).toBeNull();
    expect(screen.getByTestId('conectar-titulo')).toBeOnTheScreen();
    expect(
      await screen.findByTestId('conectar-encostado', {}, { timeout: 5000 }),
    ).toBeOnTheScreen();
  });
});

describe('Conectar: Bluetooth com o cartão na tela (ux.md §11.15; PROX-69)', () => {
  it('PROX-69 (11): o Bluetooth desligado não muda a tela; a saída leva ao 4, com o foco no título do EmptyState; religado, a varredura recomeça no Pronto', async () => {
    const { radio } = await openCard(CAIO);
    expect(radio.scanStarts).toBe(1);
    await act(async () => {
      radio.emitState('off');
      await Promise.resolve();
    });
    await advance(1000);
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(screen.queryByTestId('bt-desligado')).toBeNull();
    await advance(afterFocus());
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: COPY.btOffTitle })).toBeOnTheScreen();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['bt-desligado-titulo']);
    await act(async () => {
      radio.emitState('on');
      await Promise.resolve();
    });
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    expect(radio.scanStarts).toBe(2);
  });

  it('PROX-69: o Bluetooth religado com o cartão na tela também recomeça a varredura no Pronto', async () => {
    const { radio } = await openCard(CAIO);
    await act(async () => {
      radio.emitState('off');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    await act(async () => {
      radio.emitState('on');
      await Promise.resolve();
    });
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    expect(radio.scanStarts).toBe(2);
  });

  it('PROX-69 (saída comum): a saída do cartão volta ao Pronto pelo Verificando, sem reiniciar a varredura (P7)', async () => {
    const { radio } = await openCard(CAIO);
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(radio.scanning).toBe(true);
    expect(radio.scanStarts).toBe(1);
  });

  it.each([
    ['o 21', touchItem(CAIO, 0), 'conectar-encostado-atrasado'],
    ['o 12', nearbyPerson({ alreadyConnected: true }), 'conectar-encostado-conectados'],
  ] as const)(
    'PROX-69 (%s): o Bluetooth desligado e o erro do rádio não mudam a tela',
    async (_case, item, testID) => {
      const { radio } = await openCard(item);
      await act(async () => {
        radio.emitState('off');
        radio.emitError({ operation: 'advertise', code: 'unsupported' });
        await Promise.resolve();
      });
      await advance(1000);
      expect(screen.getByTestId(testID)).toBeOnTheScreen();
      expect(screen.queryByTestId('bt-desligado')).toBeNull();
      expect(screen.queryByText(COPY.unsupportedBanner)).toBeNull();
    },
  );

  it('PROX-69 (Bloqueado): o Bluetooth desligado não muda a tela; "Voltar" leva ao 4', async () => {
    const pressAlert = captureAlert();
    const { radio } = await openCard(CAIO);
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await pressAlert('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    await act(async () => {
      radio.emitState('off');
      await Promise.resolve();
    });
    await advance(1000);
    expect(screen.getByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.back }));
    expect(await screen.findByRole('header', { name: COPY.btOffTitle })).toBeOnTheScreen();
  });

  it('PROX-69 (Aguardando, 13): o Bluetooth desligado não muda a tela; "Cancelar pedido" leva ao 4, com o foco no título do EmptyState', async () => {
    const request = connectionRequest();
    const { radio } = await openCard(CAIO, (fake) => {
      fake.on('POST /v1/connections/requests', { status: 201, body: request });
      fake.on(`GET /v1/connections/requests/${request.id}`, { status: 200, body: request });
      fake.on(`DELETE /v1/connections/requests/${request.id}`, {
        status: 200,
        body: { ...request, status: 'cancelled' },
      });
    });
    await userEvent.press(
      screen.getByRole('button', { name: COPY.connectWithLabel('Caio Ribeiro', 'caio.r') }),
    );
    expect(await screen.findByTestId('conectar-aguardando')).toBeOnTheScreen();
    await act(async () => {
      radio.emitState('off');
      await Promise.resolve();
    });
    await advance(1000);
    expect(screen.getByTestId('conectar-aguardando')).toBeOnTheScreen();
    expect(screen.queryByTestId('bt-desligado')).toBeNull();
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancelRequest }));
    expect(await screen.findByRole('header', { name: COPY.btOffTitle })).toBeOnTheScreen();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['bt-desligado-titulo']);
  });
});

/** O `getCapabilities` do Verificando que demora (o iPhone recriando o gerenciador do Bluetooth). */
const SLOW_CAPABILITIES_MS = 400;

function slowCapabilities(radio: FakeRadio) {
  radio.getCapabilities = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ ...radio.capabilities });
      }, SLOW_CAPABILITIES_MS);
    });
}

/**
 * ux.md §11.17, C2: o cartão acabou de sair e a tela está no Verificando lento. O Toast da saída só
 * aparece com o Pronto, e o anúncio dele sai depois do foco no título.
 */
async function expectExitToastAfterFocus(message: string) {
  expect(screen.getByTestId('conectar-verificando')).toBeOnTheScreen();
  expect(screen.queryByText(message)).toBeNull();
  expect(queued).not.toHaveBeenCalledWith(message, expect.anything());
  await advance(SLOW_CAPABILITIES_MS);
  expect(screen.getByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  expect(screen.getByText(message)).toBeOnTheScreen();
  await advance(afterFocus());
  expect(focusedTestIds()).toEqual(['conectar-titulo']);
  expectAnnouncedAfterFocus(message, 'conectar-titulo');
}

describe('Conectar: o foco no estado de início (ux.md §11.8 e §11.17, C1 e S2; PROX-69)', () => {
  it('PROX-69 (C1, o erro do rádio no Pronto): a permissão retirada com a tela no Pronto leva ao 3, com o foco no título do EmptyState', async () => {
    const { radio } = await openReady();
    radio.startAdvertising = () =>
      Promise.reject(
        Object.assign(new Error('sem permissão'), { code: 'ERR_BLUETOOTH_PERMISSION' }),
      );
    focus.mockClear();
    // A renovação dos 20 s troca o bleToken, e o anúncio novo falha.
    await advance(20_000);
    expect(await screen.findByRole('header', { name: COPY.btDeniedTitle })).toBeOnTheScreen();
    await advance(1000);
    expect(focusedTestIds()).toEqual(['bt-negado-titulo']);
  });

  it('PROX-69 (S2, "Continuar" recusado): na abertura, o foco fica onde está; o "Continuar" some com a recusa, e o foco vai ao título do 3', async () => {
    const radio = createFakeRadio({ permission: 'undetermined' });
    radio.permissionAnswer = 'denied';
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureConnect,
    });
    expect(await screen.findByRole('header', { name: COPY.btExplainTitle })).toBeOnTheScreen();
    await advance(1000);
    expect(focusedTestIds()).toEqual([]);
    await userEvent.press(screen.getByRole('button', { name: COPY.continue }));
    expect(await screen.findByRole('header', { name: COPY.btDeniedTitle })).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toEqual(['bt-negado-titulo']);
  });

  it.each([
    [
      'a permissão dada, mas o celular não anuncia',
      (radio: FakeRadio) => {
        radio.requestPermission = () =>
          Promise.resolve({ ...radio.capabilities, permission: 'granted', canAdvertise: false });
      },
    ],
    [
      'o pedido do sistema falha',
      (radio: FakeRadio) => {
        radio.requestPermission = () => Promise.reject(new Error('módulo indisponível'));
      },
    ],
  ] as const)(
    'PROX-69 (S2, "Continuar" que leva ao 5, %s): o "Continuar" some, e o foco vai à faixa T30 do QR',
    async (_case, setUp) => {
      const radio = createFakeRadio({ permission: 'undetermined' });
      setUp(radio);
      await renderApp({
        signedInAs: personalMe(),
        initialUrl: '/pessoal/conectar',
        radio,
        configure: configureConnect,
      });
      expect(await screen.findByRole('header', { name: COPY.btExplainTitle })).toBeOnTheScreen();
      await advance(1000);
      expect(focusedTestIds()).toEqual([]);
      await userEvent.press(screen.getByRole('button', { name: COPY.continue }));
      expect(await screen.findByTestId('conectar-sem-suporte-faixa')).toBeOnTheScreen();
      expect(screen.getByRole('radio', { name: 'QR code' })).toBeChecked();
      await advance(connectTiming.focusDelayMs);
      expect(focusedTestIds()).toEqual(['conectar-sem-suporte-faixa']);
    },
  );

  it('PROX-69 (S2, a volta dos Ajustes sem resolver): o 3 volta pelo Verificando, e o foco vai ao título dele', async () => {
    const setAppState = captureAppState();
    jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const radio = createFakeRadio({ permission: 'denied', canAskAgain: false });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureConnect,
    });
    await userEvent.press(await screen.findByRole('button', { name: COPY.openSettings }));
    await advance(1000);
    expect(focusedTestIds()).toEqual([]);
    await setAppState('background');
    await setAppState('active');
    expect(await screen.findByRole('header', { name: COPY.btDeniedTitle })).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toEqual(['bt-negado-titulo']);
  });
});

describe('Conectar: o Toast da saída do cartão espera a tela de início (ux.md §11.17, C2; PROX-69)', () => {
  it('PROX-69 (C2, T20): com o Verificando lento (400 ms), o T20 aparece com o Pronto e é anunciado depois do foco no título', async () => {
    const { radio, cardAt } = await openCard(CAIO);
    slowCapabilities(radio);
    await advance(afterFocus());
    focus.mockClear();
    queued.mockClear();
    await advance(cardAt + CARD_TTL_MS + 100 - Date.now());
    await expectExitToastAfterFocus(COPY.cardExpired('Caio'));
  });

  it('PROX-69 (C2, "O pedido de … expirou."): o pedido do 14 vence com o Verificando lento; o Toast aparece com o Pronto e é anunciado depois do foco no título', async () => {
    const request = incomingRequest({ expiresInS: 3 });
    let pending = false;
    let seenAt = 0;
    const { radio } = await openCard(touchItem(HELENA), (fake) => {
      fake.on('GET /v1/connections/requests/incoming', () => {
        if (pending && seenAt === 0) seenAt = Date.now();
        return { status: 200, body: { items: pending ? [request] : [] } };
      });
    });
    pending = true;
    expect(await screen.findByTestId('conectar-pedido-cartao')).toBeOnTheScreen();
    slowCapabilities(radio);
    await advance(afterFocus());
    focus.mockClear();
    queued.mockClear();
    await advance(seenAt + 3000 + 50 - Date.now());
    await expectExitToastAfterFocus(COPY.expired('Helena'));
  });

  it('PROX-69 / PROX-61 (C2, M5): "Bloquear" no 12 com o Verificando lento; o blockedMessage aparece com o Pronto e é anunciado depois do foco no título', async () => {
    const pressAlert = captureAlert();
    const { radio } = await openCard(nearbyPerson({ alreadyConnected: true }));
    slowCapabilities(radio);
    await advance(afterFocus());
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    focus.mockClear();
    queued.mockClear();
    await pressAlert('Bloquear');
    await advance(50);
    await expectExitToastAfterFocus(blockedMessage('caio.r'));
  });

  it('PROX-69 / PROX-61 (C2, M7): "Bloquear" confirmado depois do prazo com o Verificando lento; o PROFILE_GONE_MESSAGE aparece com o Pronto e é anunciado depois do foco no título', async () => {
    const pressAlert = captureAlert();
    const { radio, api, cardAt } = await openCard(CAIO);
    slowCapabilities(radio);
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await advance(cardAt + CARD_TTL_MS + 5000 - Date.now());
    focus.mockClear();
    queued.mockClear();
    await pressAlert('Bloquear');
    await expectExitToastAfterFocus(PROFILE_GONE_MESSAGE);
    expect(api.callsTo('POST /v1/me/blocks')).toHaveLength(0);
  });

  it('PROX-69 / PROX-62 (C2, M10): o 404 da denúncia depois do prazo com o Verificando lento; o PROFILE_GONE_MESSAGE aparece com o Pronto e é anunciado depois do foco no título', async () => {
    const { radio, cardAt } = await openCard(CAIO, (fake) => {
      fake.on('POST /v1/reports', apiError(404, 'NOT_FOUND'));
    });
    slowCapabilities(radio);
    await userEvent.press(screen.getByTestId('cartao-denunciar'));
    const form = within(await screen.findByTestId('conectar-denunciar'));
    await userEvent.press(form.getByRole('radio', { name: 'Spam ou golpe' }));
    await advance(cardAt + CARD_TTL_MS + 5000 - Date.now());
    focus.mockClear();
    queued.mockClear();
    await userEvent.press(form.getByRole('button', { name: 'Enviar' }));
    // No iOS, a saída espera o `onDismiss` do formulário (ou a folga de segurança).
    await advance(connectTiming.formDismissFallbackMs);
    await expectExitToastAfterFocus(PROFILE_GONE_MESSAGE);
  });

  it('PROX-69 (C2, sair da aba no Verificando): o T20 guardado não se perde — aparece na outra tela e é anunciado na hora, sem esperar um foco que não vem', async () => {
    const { radio, cardAt } = await openCard(CAIO);
    slowCapabilities(radio);
    await advance(afterFocus());
    queued.mockClear();
    announce.mockClear();
    await advance(cardAt + CARD_TTL_MS + 50 - Date.now());
    expect(screen.getByTestId('conectar-verificando')).toBeOnTheScreen();
    expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    expect(await screen.findByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
    expect(screen.queryByTestId('conectar-verificando')).toBeNull();
    expect(announce).toHaveBeenCalledWith(COPY.cardExpired('Caio'));
    await advance(afterFocus());
    expect(queued).not.toHaveBeenCalledWith(COPY.cardExpired('Caio'), expect.anything());
  });

  it('PROX-69 (C2, sem suporte): a saída vai ao QR na hora, sem a conferência; o T20 aparece com a faixa T30 e é anunciado depois do foco nela', async () => {
    const { radio, cardAt } = await openCard(CAIO);
    slowCapabilities(radio);
    await act(async () => {
      radio.emitError({ operation: 'advertise', code: 'unsupported' });
      await Promise.resolve();
    });
    await advance(afterFocus());
    focus.mockClear();
    queued.mockClear();
    await advance(cardAt + CARD_TTL_MS + 100 - Date.now());
    expect(screen.getByTestId('conectar-sem-suporte-faixa')).toBeOnTheScreen();
    expect(screen.getByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['conectar-sem-suporte-faixa']);
    expectAnnouncedAfterFocus(COPY.cardExpired('Caio'), 'conectar-sem-suporte-faixa');
  });
});

describe('Conectar: o aviso aos 7 s (A3-3 item 8; PROX-70)', () => {
  it('PROX-70: sem confirmação, o "Encostou!" fica até os 7 s, e o T11 sai aos 7 s', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        fake.on('POST /v1/proximity/touches', { status: 200, body: { items: [] } });
      },
    });
    await touch(radio);
    expect(await screen.findByRole('header', { name: COPY.confirmingTitle })).toBeOnTheScreen();
    expect(CAL.confirmWarnAfterMs).toBe(7000);
    // O encosto foi admitido durante o `touch` (até ~0,5 s antes daqui): aos ~6,5 s, ainda não.
    await advance(6_000);
    expect(screen.getByRole('header', { name: COPY.confirmingTitle })).toBeOnTheScreen();
    expect(screen.queryByText(COPY.touchFailed)).toBeNull();
    expect(await screen.findByText(COPY.touchFailed, {}, { timeout: 2000 })).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(COPY.touchFailed);
  });
});
