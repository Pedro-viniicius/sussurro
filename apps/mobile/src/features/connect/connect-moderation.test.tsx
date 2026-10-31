import { ErrorCode, type NearbyPerson } from '@sussurro/shared';
import { userEvent } from '@testing-library/react-native';
import { act, screen, waitFor, within } from 'expo-router/testing-library';
import {
  AccessibilityInfo,
  Alert,
  type AlertButton,
  AppState,
  type AppStateStatus,
  Platform,
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
import { errorMessage, OFFLINE_MESSAGE } from '../../lib/error-messages';
import {
  apiError,
  CAIO_TOKEN,
  configureConnect,
  connectionRequest,
  incomingRequest,
  mutualTouches,
  nearbyPerson,
} from '../../test-utils/connect-fixtures';
import { type FakeApi, type FakeReply, personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';
import { REPORT_DETAILS_LABEL, REPORT_SENT_MESSAGE } from '../moderation/ReportForm';
import { BLOCK_MESSAGE, blockedMessage, blockTitle } from '../moderation/useBlockAccount';
import { PROFILE_GONE_MESSAGE } from '../relations/useFollowToggle';

const SAVED_TIMING = { ...connectTiming };
const CAL = TOUCH_CALIBRATION;
const TX_REF = CAL.advertiserTxDbm;
const CAIO = nearbyPerson();
const HELENA = nearbyPerson({ handle: 'helena', name: 'Helena Souza' });
const CARD_TTL_MS = 55_000;
const UNAVAILABLE = errorMessage(ErrorCode.PROXIMITY_UNAVAILABLE);
const RATE_LIMITED = errorMessage(ErrorCode.RATE_LIMITED);

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

async function touch(radio: FakeRadio, token = CAIO_TOKEN) {
  for (let elapsed = 0; elapsed < 1400; elapsed += CAL.sightingMinIntervalMs) {
    await act(async () => {
      radio.emitSighting(token, TX_REF - 30);
      await jest.advanceTimersByTimeAsync(CAL.sightingMinIntervalMs);
    });
  }
}

/** Responde ao `Alert` de "Bloquear @…?" apertando o botão pedido. */
function captureAlert() {
  const alerts: { title: string; message: string | undefined; buttons: AlertButton[] }[] = [];
  jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons) => {
    alerts.push({ title: title ?? '', message: message ?? undefined, buttons: buttons ?? [] });
  });
  return {
    alerts,
    async press(text: string) {
      const button = alerts.at(-1)?.buttons.find((candidate) => candidate.text === text);
      expect(button).toBeDefined();
      await act(async () => {
        button?.onPress?.();
        await Promise.resolve();
      });
    },
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

/** Resposta depois de `ms` (relógio falso). */
function later(ms: number, reply: FakeReply): Promise<FakeReply> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(reply);
    }, ms);
  });
}

/** Abre o Conectar, encosta e espera o cartão (o 2º relato traz o cartão). */
async function openCard(
  options: { person?: NearbyPerson; configure?: (api: FakeApi) => void } = {},
) {
  const person = options.person ?? CAIO;
  const radio = createFakeRadio();
  const rendered = await renderApp({
    signedInAs: personalMe(),
    initialUrl: '/pessoal/conectar',
    radio,
    configure: (fake) => {
      configureConnect(fake);
      fake.on('POST /v1/proximity/touches', mutualTouches({ [CAIO_TOKEN]: person }));
      fake.on('POST /v1/me/blocks', { status: 204 });
      fake.on('POST /v1/reports', { status: 202 });
      options.configure?.(fake);
    },
  });
  expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  await waitFor(() => {
    expect(radio.scanning).toBe(true);
  });
  await touch(radio);
  expect(await screen.findByRole('header', { name: person.name })).toBeOnTheScreen();
  const cardAt = Date.now();
  await advance(afterFocus());
  focus.mockClear();
  queued.mockClear();
  announce.mockClear();
  return { ...rendered, radio, cardAt };
}

/** O formulário de denúncia aberto por cima do cartão. */
function reportModal() {
  return within(screen.getByTestId('conectar-denunciar'));
}

/** Toca em ‹Denunciar› no cartão e espera o formulário. */
async function openReport() {
  await userEvent.press(screen.getByTestId('cartao-denunciar'));
  expect(await screen.findByTestId('conectar-denunciar')).toBeOnTheScreen();
}

/** Escolhe o motivo e, se pedido, escreve os detalhes. */
async function fillReport(details?: string) {
  await userEvent.press(reportModal().getByRole('radio', { name: 'Spam ou golpe' }));
  if (details !== undefined) {
    await userEvent.paste(reportModal().getByLabelText(REPORT_DETAILS_LABEL), details);
  }
}

/** O `Modal` saiu: no iOS, espera o `onDismiss` (ou a folga de segurança). */
async function formDismissed() {
  await advance(connectTiming.formDismissFallbackMs);
}

let vibrate: jest.SpyInstance;

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, tickMs: 20 });
  resetTouchReportGate();
  announce.mockClear();
  queued.mockClear();
  focus.mockClear();
  vibrate = jest.spyOn(haptics, 'vibrate').mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('Conectar: bloquear pelo cartão (ux.md §11.14; PROX-61)', () => {
  it('PROX-61 / PROX-62 (11): a linha mostra "Denunciar" e depois "Bloquear", abaixo do ‹Cancelar›, e fica desativada enquanto o Conectar está em andamento', async () => {
    await openCard({
      configure: (fake) => {
        fake.on('POST /v1/connections/requests', () =>
          later(2000, { status: 201, body: connectionRequest() }),
        );
      },
    });
    const card = within(screen.getByTestId('conectar-encostado'));
    expect(
      card.getAllByRole('button').map((node) => String(node.props.accessibilityLabel)),
    ).toEqual([
      COPY.connectWithLabel('Caio Ribeiro', 'caio.r'),
      COPY.cancel,
      'Denunciar',
      'Bloquear',
    ]);
    expect(screen.getByTestId('cartao-bloquear').props.hitSlop).toEqual({ top: 5, bottom: 5 });
    await userEvent.press(
      screen.getByRole('button', { name: COPY.connectWithLabel('Caio Ribeiro', 'caio.r') }),
    );
    expect(screen.getByTestId('cartao-denunciar')).toBeDisabled();
    expect(screen.getByTestId('cartao-bloquear')).toBeDisabled();
    expect(screen.getByRole('button', { name: COPY.cancel })).toBeDisabled();
  });

  it('PROX-61 (M1 a M4): no 11, o Alert do perfil; "Cancelar" não muda nada; "Bloquear" manda POST /me/blocks {handle}; o 204 leva ao Bloqueado (só Denunciar), com o foco no nome e o blockedMessage depois, sem Toast nem vibração', async () => {
    const alert = captureAlert();
    const { api } = await openCard();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    expect(alert.alerts).toHaveLength(1);
    expect(alert.alerts[0]?.title).toBe(blockTitle('caio.r'));
    expect(alert.alerts[0]?.message).toBe(BLOCK_MESSAGE);
    expect(alert.alerts[0]?.buttons.map((button) => button.text)).toEqual(['Cancelar', 'Bloquear']);
    expect(alert.alerts[0]?.buttons[1]?.style).toBe('destructive');
    // M2: "Cancelar" não muda nada (o sistema devolve o foco ao ‹Bloquear›).
    await alert.press('Cancelar');
    await advance(1000);
    expect(api.callsTo('POST /v1/me/blocks')).toHaveLength(0);
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(focusedTestIds()).toEqual([]);

    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/me/blocks').map((call) => call.body)).toEqual([
      { handle: 'caio.r' },
    ]);
    expect(screen.getByText(blockedMessage('caio.r'))).toBeOnTheScreen();
    expect(screen.queryByText('Conectar com Caio')).toBeNull();
    expect(screen.getByRole('button', { name: COPY.back })).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-denunciar')).toBeOnTheScreen();
    expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expectAnnouncedAfterFocus(blockedMessage('caio.r'), 'cartao-nome');
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(vibrate.mock.calls).toEqual([['touched']]);
    // O "Bloquear" roda o mesmo que o perfil: o `GET /me` é recarregado.
    expect(api.callsTo('GET /v1/me').length).toBeGreaterThanOrEqual(2);
  });

  it('PROX-62 / PROX-65 (R1-PO-1, M13): o Bloqueado não vence — depois do expiresAt continua na tela, com o ‹Denunciar›, sem o T20 e sem manter a tela acesa', async () => {
    const alert = captureAlert();
    const { cardAt, radio } = await openCard();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    // Sem prazo, como o 12: a tela não fica acesa.
    await waitFor(() => {
      expect(radio.keepScreenOn).toBe(false);
    });
    await advance(afterFocus());
    focus.mockClear();
    queued.mockClear();
    await advance(cardAt + 60_000 + 30_000 - Date.now());
    expect(screen.getByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-denunciar')).toBeEnabled();
    expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
    expect(screen.getByRole('button', { name: COPY.back })).toBeEnabled();
    expect(radio.keepScreenOn).toBe(false);
    expect(focusedTestIds()).toEqual([]);
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
    expect(queued).not.toHaveBeenCalledWith(COPY.cardExpired('Caio'), expect.anything());
  });

  it('PROX-61 (M13): "Voltar" no Bloqueado volta ao Pronto sem Toast, com o foco no título', async () => {
    const alert = captureAlert();
    await openCard();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    await advance(afterFocus());
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.back }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['conectar-titulo']);
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('PROX-61 / PROX-62 (M4, 14): no pedido do cartão, o Bloqueado aparece sem Aceitar e sem Recusar; o pedido sai sem o Toast "não está mais disponível", mesmo com o polling devolvendo o pedido cancelado; o formulário aberto pelo Bloqueado vem sem o T46 (R1-PO-1)', async () => {
    const alert = captureAlert();
    const request = incomingRequest();
    let polled: 'none' | 'pending' | 'cancelled' = 'none';
    await openCard({
      person: HELENA,
      configure: (fake) => {
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: {
            items:
              polled === 'none'
                ? []
                : [{ ...request, status: polled === 'pending' ? 'pending' : 'cancelled' }],
          },
        }));
        fake.on('POST /v1/me/blocks', () => {
          polled = 'cancelled';
          return { status: 204 };
        });
      },
    });
    polled = 'pending';
    expect(
      await screen.findByRole('header', { name: 'Helena quer se conectar' }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-bloquear')).toBeOnTheScreen();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Helena Souza' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: COPY.accept })).toBeNull();
    expect(screen.queryByRole('button', { name: COPY.decline })).toBeNull();
    await advance(2000);
    expect(screen.queryByText(COPY.gone('Helena'))).toBeNull();
    expect(screen.queryByTestId('folha-pedido')).toBeNull();
    expect(screen.getByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    // Sem o T46 no formulário aberto pelo Bloqueado: quem bloqueou denuncia sem prazo (R1-PO-1).
    await openReport();
    expect(
      reportModal().getByRole('header', { name: 'Por que você está denunciando @helena?' }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(COPY.reportDeadline)).toBeNull();
  });

  it('PROX-61 / PROX-62 (M14, 14): o T46 no formulário aberto pelo 14; a linha some no expiresAt do cartão e o pedido continua com o "Expira em"; o foco não salta', async () => {
    const request = incomingRequest();
    let pending = false;
    const { cardAt } = await openCard({
      person: HELENA,
      configure: (fake) => {
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: pending ? [request] : [] },
        }));
      },
    });
    pending = true;
    expect(
      await screen.findByRole('header', { name: 'Helena quer se conectar' }),
    ).toBeOnTheScreen();
    // T46 no formulário aberto pelo 14; "Cancelar" volta ao cartão.
    await openReport();
    expect(reportModal().getByText(COPY.reportDeadline)).toBeOnTheScreen();
    await userEvent.press(reportModal().getByRole('button', { name: 'Cancelar' }));
    await formDismissed();
    await advance(afterFocus());
    focus.mockClear();
    await advance(cardAt + CARD_TTL_MS - 500 - Date.now());
    expect(screen.getByTestId('cartao-denunciar')).toBeOnTheScreen();
    await advance(1000);
    expect(screen.queryByTestId('cartao-denunciar')).toBeNull();
    expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
    expect(screen.getByTestId('conectar-pedido-cartao')).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-prazo')).toHaveTextContent(/^Expira em 1:\d\d$/);
    await advance(1000);
    expect(focusedTestIds()).toEqual([]);
  });

  it('PROX-61 (M2 + M14, 14): depois do "Cancelar" no Alert (o foco ficou no ‹Bloquear›), a linha some no prazo e o foco vai ao título do cartão', async () => {
    const alert = captureAlert();
    const request = incomingRequest();
    let pending = false;
    const { cardAt } = await openCard({
      person: HELENA,
      configure: (fake) => {
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: pending ? [request] : [] },
        }));
      },
    });
    pending = true;
    expect(
      await screen.findByRole('header', { name: 'Helena quer se conectar' }),
    ).toBeOnTheScreen();
    await advance(afterFocus());
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Cancelar');
    focus.mockClear();
    await advance(cardAt + CARD_TTL_MS + 500 - Date.now());
    expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toEqual(['cartao-titulo']);
  });

  it('PROX-61 (M5, 12): a linha continua depois de 55 s; "Bloquear" com 204 fecha o cartão, com o Toast blockedMessage depois do foco no título do Pronto', async () => {
    const alert = captureAlert();
    const { api } = await openCard({ person: nearbyPerson({ alreadyConnected: true }) });
    await advance(60_000);
    expect(screen.getByTestId('conectar-encostado-conectados')).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-denunciar')).toBeOnTheScreen();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Bloquear');
    expect(await screen.findByText(blockedMessage('caio.r'))).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/me/blocks').map((call) => call.body)).toEqual([
      { handle: 'caio.r' },
    ]);
    await advance(afterFocus());
    expectAnnouncedAfterFocus(blockedMessage('caio.r'), 'conectar-titulo');
  });

  it.each([
    ['503 PROXIMITY_UNAVAILABLE', apiError(503, 'PROXIMITY_UNAVAILABLE'), UNAVAILABLE],
    ['429', apiError(429, 'RATE_LIMITED'), RATE_LIMITED],
    ['sem rede', 'offline', OFFLINE_MESSAGE],
  ] as const)(
    'PROX-61 (M6, %s): o bloqueio mostra o Toast com o texto e o cartão fica igual, com o Conectar; nunca vai aos estados 18 a 20',
    async (_case, reply, message) => {
      const alert = captureAlert();
      await openCard({
        configure: (fake) => {
          fake.on('POST /v1/me/blocks', () => {
            if (reply === 'offline') throw new Error('sem rede');
            return reply;
          });
        },
      });
      await userEvent.press(screen.getByTestId('cartao-bloquear'));
      await alert.press('Bloquear');
      expect(await screen.findByText(message)).toBeOnTheScreen();
      expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
      expect(screen.getByText('Conectar com Caio')).toBeOnTheScreen();
      expect(screen.getByTestId('cartao-bloquear')).toBeEnabled();
      for (const halted of ['conectar-indisponivel', 'conectar-pausado', 'conectar-offline']) {
        expect(screen.queryByTestId(halted)).toBeNull();
      }
      // O foco fica no ‹Bloquear›.
      await advance(1000);
      expect(focusedTestIds()).toEqual([]);
    },
  );

  it('PROX-61 (M7 / M15): com o Alert aberto no expiresAt, o cartão não vence; "Bloquear" não chama a API, mostra o PROFILE_GONE_MESSAGE e o 11 volta ao Pronto, sem o T20', async () => {
    const alert = captureAlert();
    const { api, cardAt } = await openCard();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await advance(cardAt + CARD_TTL_MS + 5000 - Date.now());
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    await alert.press('Bloquear');
    expect(await screen.findByText(PROFILE_GONE_MESSAGE)).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/me/blocks')).toHaveLength(0);
    expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
    await advance(afterFocus());
    expectAnnouncedAfterFocus(PROFILE_GONE_MESSAGE, 'conectar-titulo');
  });

  it.each([
    [2900, false],
    [3100, true],
  ] as const)(
    'PROX-61 (M7, R1-11): "Bloquear" confirmado a %i ms do fim do cartão → chama a API: %s (margem de 3 s)',
    async (left, calls) => {
      expect(connectTiming.blockConfirmMarginMs).toBe(3000);
      const alert = captureAlert();
      const touches = mutualTouches({ [CAIO_TOKEN]: CAIO });
      let cardSentAt = 0;
      const { api } = await openCard({
        configure: (fake) => {
          fake.on('POST /v1/proximity/touches', (call) => {
            const reply = touches(call);
            if ((reply.body as { items: unknown[] }).items.length > 0) cardSentAt = Date.now();
            return reply;
          });
        },
      });
      await userEvent.press(screen.getByTestId('cartao-bloquear'));
      // O cartão vence 55 s depois da chegada (pairExpiresInS = 55).
      await advance(cardSentAt + CARD_TTL_MS - left - Date.now());
      await alert.press('Bloquear');
      if (calls) {
        expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
        expect(api.callsTo('POST /v1/me/blocks')).toHaveLength(1);
        return;
      }
      // Como o M7: sem chamar a API, o PROFILE_GONE_MESSAGE e o Pronto, sem o T20.
      expect(await screen.findByText(PROFILE_GONE_MESSAGE)).toBeOnTheScreen();
      expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
      expect(api.callsTo('POST /v1/me/blocks')).toHaveLength(0);
      expect(screen.queryByText(blockedMessage('caio.r'))).toBeNull();
      await advance(5000);
      expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
    },
  );
});

describe('Conectar: denunciar pelo cartão (ux.md §11.14; PROX-62)', () => {
  it('PROX-62 (M8, M9): o formulário abre num Modal com o cartão montado e o foco na pergunta; T46 no 11; "Enviar" só com o motivo; o 202 volta ao cartão com o Toast depois do foco no nome', async () => {
    expect(Platform.OS).toBe('ios');
    const { api } = await openCard();
    await openReport();
    // A aba continua aberta e o cartão, montado por baixo.
    expect(screen.getByTestId('tela-conectar')).toBeOnTheScreen();
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(
      reportModal().getByRole('header', { name: 'Por que você está denunciando @caio.r?' }),
    ).toBeOnTheScreen();
    expect(reportModal().getByText(COPY.reportDeadline)).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toEqual(['denuncia-pergunta']);
    expect(reportModal().getByRole('button', { name: 'Enviar' })).toBeDisabled();
    await fillReport('  Pegou meu cartão de longe  ');
    // O `onDismiss` do iOS: o que vem depois de fechar espera por ele.
    const { onDismiss } = screen.getByTestId('conectar-denunciar').props as {
      onDismiss: () => void;
    };
    focus.mockClear();
    await userEvent.press(reportModal().getByRole('button', { name: 'Enviar' }));
    await waitFor(() => {
      expect(api.callsTo('POST /v1/reports')).toHaveLength(1);
    });
    expect(api.callsTo('POST /v1/reports')[0]?.body).toEqual({
      target: { type: 'account', handle: 'caio.r' },
      reason: 'spam',
      details: 'Pegou meu cartão de longe',
    });
    expect(screen.queryByTestId('conectar-denunciar')).toBeNull();
    // Antes do `onDismiss`, nada de foco nem de Toast.
    await advance(100);
    expect(screen.queryByText(REPORT_SENT_MESSAGE)).toBeNull();
    await act(async () => {
      onDismiss();
      await Promise.resolve();
    });
    expect(await screen.findByText(REPORT_SENT_MESSAGE)).toBeOnTheScreen();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expectAnnouncedAfterFocus(REPORT_SENT_MESSAGE, 'cartao-nome');
    // Denunciar não bloqueia: Conectar, Denunciar e Bloquear continuam.
    expect(screen.getByText('Conectar com Caio')).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-denunciar')).toBeEnabled();
    expect(screen.getByTestId('cartao-bloquear')).toBeEnabled();
  });

  it('PROX-62 (M8): o T46 não aparece no formulário aberto pelo 12', async () => {
    await openCard({ person: nearbyPerson({ alreadyConnected: true }) });
    await openReport();
    expect(
      reportModal().getByRole('header', { name: 'Por que você está denunciando @caio.r?' }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(COPY.reportDeadline)).toBeNull();
  });

  it('PROX-62 (M8): o T46 não aparece na rota /denunciar', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/denunciar?alvo=conta&handle=caio.r',
    });
    expect(
      await screen.findByRole('header', { name: 'Por que você está denunciando @caio.r?' }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(COPY.reportDeadline)).toBeNull();
  });

  it('PROX-62 (M8, R1-PO-1): o T46 não aparece no formulário aberto pelo Bloqueado do 11', async () => {
    const alert = captureAlert();
    await openCard();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    await openReport();
    expect(
      reportModal().getByRole('header', { name: 'Por que você está denunciando @caio.r?' }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(COPY.reportDeadline)).toBeNull();
  });

  it('PROX-62 (M9, Bloqueado): o 202 antes do prazo volta ao Bloqueado (só o ‹Denunciar›), com o Toast depois do foco no nome', async () => {
    const alert = captureAlert();
    const { api } = await openCard();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    await advance(afterFocus());
    await openReport();
    await advance(connectTiming.focusDelayMs);
    await fillReport();
    focus.mockClear();
    queued.mockClear();
    await userEvent.press(reportModal().getByRole('button', { name: 'Enviar' }));
    await formDismissed();
    expect(await screen.findByText(REPORT_SENT_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/reports')).toHaveLength(1);
    expect(screen.getByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-denunciar')).toBeEnabled();
    expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
    expect(screen.queryByText('Conectar com Caio')).toBeNull();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expectAnnouncedAfterFocus(REPORT_SENT_MESSAGE, 'cartao-nome');
  });

  /** Bloqueia pelo cartão, abre o formulário e passa do fim do par no servidor (60 s). */
  async function reportFromBlockedAfterPair(reply: FakeReply) {
    const alert = captureAlert();
    const opened = await openCard({
      configure: (fake) => {
        fake.on('POST /v1/reports', reply);
      },
    });
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    await openReport();
    await fillReport('Escrevendo sem pressa');
    // Depois do fim do par no servidor (60 s depois do encosto): quem bloqueou denuncia sem prazo.
    await advance(opened.cardAt + 60_000 + 5_000 - Date.now());
    expect(screen.getByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    expect(reportModal().getByLabelText(REPORT_DETAILS_LABEL).props.value).toBe(
      'Escrevendo sem pressa',
    );
    focus.mockClear();
    queued.mockClear();
    await userEvent.press(reportModal().getByRole('button', { name: 'Enviar' }));
    await formDismissed();
    expect(opened.api.callsTo('POST /v1/reports').map((call) => call.body)).toEqual([
      {
        target: { type: 'account', handle: 'caio.r' },
        reason: 'spam',
        details: 'Escrevendo sem pressa',
      },
    ]);
    return opened;
  }

  it('PROX-62 / PROX-65 (R1-PO-1, M15, M9, Bloqueado, 202): o formulário aberto pelo Bloqueado vale além do fim do par (60 s); o 202 volta ao Bloqueado, só com o ‹Denunciar›, com o Toast depois do foco no nome e sem o T20', async () => {
    await reportFromBlockedAfterPair({ status: 202 });
    expect(await screen.findByText(REPORT_SENT_MESSAGE)).toBeOnTheScreen();
    expect(screen.getByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-denunciar')).toBeEnabled();
    expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expectAnnouncedAfterFocus(REPORT_SENT_MESSAGE, 'cartao-nome');
    expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
    expect(queued).not.toHaveBeenCalledWith(COPY.cardExpired('Caio'), expect.anything());
  });

  it('PROX-62 / PROX-65 (R1-PO-1, M15, M10, Bloqueado, 404 da conta excluída): o envio depois do fim do par volta ao Pronto com o PROFILE_GONE_MESSAGE, sem o T20', async () => {
    await reportFromBlockedAfterPair(apiError(404, 'NOT_FOUND'));
    expect(await screen.findByText(PROFILE_GONE_MESSAGE)).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
    await advance(afterFocus());
    expectAnnouncedAfterFocus(PROFILE_GONE_MESSAGE, 'conectar-titulo');
    expect(queued).not.toHaveBeenCalledWith(COPY.cardExpired('Caio'), expect.anything());
  });

  it('PROX-62 / PROX-65 (R1-PO-1, M12 / M15, Bloqueado): "Cancelar" depois do prazo volta ao Bloqueado, com o foco no nome, sem Toast nem o T20', async () => {
    const alert = captureAlert();
    const { api, cardAt } = await openCard();
    await userEvent.press(screen.getByTestId('cartao-bloquear'));
    await alert.press('Bloquear');
    expect(await screen.findByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    await openReport();
    await advance(cardAt + CARD_TTL_MS + 3000 - Date.now());
    expect(screen.getByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    focus.mockClear();
    await userEvent.press(reportModal().getByRole('button', { name: 'Cancelar' }));
    await formDismissed();
    await advance(afterFocus());
    expect(screen.getByTestId('conectar-encostado-bloqueado')).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-denunciar')).toBeEnabled();
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
    expect(api.callsTo('POST /v1/reports')).toHaveLength(0);
    // "Voltar" (M13) sai sem Toast, com o foco no título do Pronto.
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.back }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['conectar-titulo']);
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it.each([
    ['202', { status: 202 }, REPORT_SENT_MESSAGE],
    ['404', apiError(404, 'NOT_FOUND'), PROFILE_GONE_MESSAGE],
  ] as const)(
    'PROX-62 (M15, M9/M10, %s): o formulário aberto depois do expiresAt segura o cartão e o texto; ao enviar, volta ao Pronto com o aviso, sem o T20',
    async (_case, reply, message) => {
      const { cardAt } = await openCard({
        configure: (fake) => {
          fake.on('POST /v1/reports', reply);
        },
      });
      await openReport();
      await fillReport('Detalhe que não pode se perder');
      await advance(cardAt + CARD_TTL_MS + 10_000 - Date.now());
      expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
      expect(reportModal().getByLabelText(REPORT_DETAILS_LABEL).props.value).toBe(
        'Detalhe que não pode se perder',
      );
      expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
      focus.mockClear();
      await userEvent.press(reportModal().getByRole('button', { name: 'Enviar' }));
      await formDismissed();
      expect(await screen.findByText(message)).toBeOnTheScreen();
      expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
      expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
      await advance(afterFocus());
      expectAnnouncedAfterFocus(message, 'conectar-titulo');
    },
  );

  it.each([
    ['503 PROXIMITY_UNAVAILABLE', apiError(503, 'PROXIMITY_UNAVAILABLE'), UNAVAILABLE],
    ['429', apiError(429, 'RATE_LIMITED'), RATE_LIMITED],
    ['sem rede', 'offline', OFFLINE_MESSAGE],
  ] as const)(
    'PROX-62 (M11, %s): o formulário fica com o motivo e o texto; a linha de erro aparece e é anunciada uma vez; "Enviar" volta a funcionar; nenhum Toast',
    async (_case, reply, message) => {
      let fail = true;
      const { api } = await openCard({
        configure: (fake) => {
          fake.on('POST /v1/reports', () => {
            if (!fail) return later(1000, { status: 202 });
            if (reply === 'offline') throw new Error('sem rede');
            return reply;
          });
        },
      });
      await openReport();
      await fillReport('Meu texto');
      await userEvent.press(reportModal().getByRole('button', { name: 'Enviar' }));
      expect(await screen.findByTestId('conectar-denunciar-erro')).toHaveTextContent(message);
      expect(announce.mock.calls.filter(([text]) => text === message)).toHaveLength(1);
      expect(reportModal().getByRole('radio', { name: 'Spam ou golpe' })).toBeChecked();
      expect(reportModal().getByLabelText(REPORT_DETAILS_LABEL).props.value).toBe('Meu texto');
      expect(reportModal().getByRole('button', { name: 'Enviar' })).toBeEnabled();
      expect(screen.queryByTestId('toast')).toBeNull();
      // O envio seguinte tira a linha.
      fail = false;
      await userEvent.press(reportModal().getByRole('button', { name: 'Enviar' }));
      expect(screen.queryByTestId('conectar-denunciar-erro')).toBeNull();
      expect(api.callsTo('POST /v1/reports')).toHaveLength(2);
    },
  );

  it('PROX-62 (M12): "Cancelar" antes do prazo volta ao cartão, com o foco no nome', async () => {
    const { api } = await openCard();
    await openReport();
    await fillReport('Rascunho');
    focus.mockClear();
    await userEvent.press(reportModal().getByRole('button', { name: 'Cancelar' }));
    await formDismissed();
    await advance(afterFocus());
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(focusedTestIds()).toEqual(['cartao-nome']);
    expect(api.callsTo('POST /v1/reports')).toHaveLength(0);
    // O texto se perde: o formulário reabre vazio.
    await openReport();
    expect(reportModal().getByLabelText(REPORT_DETAILS_LABEL).props.value).toBe('');
  });

  it('PROX-62 (M12 / M15): "Cancelar" depois do prazo leva ao estado 17, com o T20 depois do foco no título', async () => {
    const { cardAt } = await openCard();
    await openReport();
    await advance(cardAt + CARD_TTL_MS + 3000 - Date.now());
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    focus.mockClear();
    await userEvent.press(reportModal().getByRole('button', { name: 'Cancelar' }));
    await formDismissed();
    expect(await screen.findByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(afterFocus());
    expectAnnouncedAfterFocus(COPY.cardExpired('Caio'), 'conectar-titulo');
  });

  it('PROX-62 (M16): o pedido da mesma pessoa chega com o formulário aberto (11 → 14): sem vibração nem A5 até fechar; ao fechar, o foco vai ao título e o A5 sai depois', async () => {
    const request = incomingRequest();
    let pending = false;
    await openCard({
      person: HELENA,
      configure: (fake) => {
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: pending ? [request] : [] },
        }));
      },
    });
    await openReport();
    pending = true;
    await advance(2000);
    expect(screen.getByTestId('conectar-pedido-cartao')).toBeOnTheScreen();
    expect(vibrate).not.toHaveBeenCalledWith('incoming');
    expect(queued).not.toHaveBeenCalledWith(COPY.announceIncoming('Helena'), expect.anything());
    focus.mockClear();
    await advance(2000);
    expect(focusedTestIds()).toEqual([]);
    await userEvent.press(reportModal().getByRole('button', { name: 'Cancelar' }));
    await formDismissed();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['cartao-titulo']);
    expect(vibrate).toHaveBeenCalledWith('incoming');
    expectAnnouncedAfterFocus(COPY.announceIncoming('Helena'), 'cartao-titulo');
  });

  it('PROX-62 (M15): na volta do background, o formulário e o texto estão como estavam', async () => {
    const setAppState = captureAppState();
    await openCard();
    await openReport();
    await fillReport('Escrevendo com calma');
    await setAppState('background');
    await advance(30_000);
    await setAppState('active');
    await advance(2000);
    expect(screen.getByTestId('conectar-denunciar')).toBeOnTheScreen();
    expect(reportModal().getByRole('radio', { name: 'Spam ou golpe' })).toBeChecked();
    expect(reportModal().getByLabelText(REPORT_DETAILS_LABEL).props.value).toBe(
      'Escrevendo com calma',
    );
  });
});

describe('Conectar: onde a linha não aparece (ux.md §11.14)', () => {
  it('PROX-61 / PROX-62: no QR, no "Aguardando" (p13) e na folha do pedido (§4.11), sem ‹Denunciar› nem ‹Bloquear›', async () => {
    const request = incomingRequest();
    let pending = false;
    await openCard({
      configure: (fake) => {
        fake.on('POST /v1/connections/requests', { status: 201, body: connectionRequest() });
        fake.on(`GET /v1/connections/requests/${connectionRequest().id}`, {
          status: 200,
          body: connectionRequest(),
        });
        fake.on(`DELETE /v1/connections/requests/${connectionRequest().id}`, {
          status: 200,
          body: connectionRequest({ status: 'cancelled' }),
        });
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: pending ? [request] : [] },
        }));
      },
    });
    // p13: "Aguardando Caio confirmar".
    await userEvent.press(
      screen.getByRole('button', { name: COPY.connectWithLabel('Caio Ribeiro', 'caio.r') }),
    );
    expect(await screen.findByTestId('conectar-aguardando')).toBeOnTheScreen();
    expect(screen.queryByTestId('cartao-denunciar')).toBeNull();
    expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
    // A folha de um pedido de outra pessoa (Helena), por cima do "Aguardando".
    pending = true;
    expect(await screen.findByTestId('folha-pedido')).toBeOnTheScreen();
    expect(within(screen.getByTestId('folha-pedido')).queryByText('Denunciar')).toBeNull();
    expect(screen.queryByTestId('cartao-denunciar')).toBeNull();
    pending = false;
    await userEvent.press(screen.getByRole('button', { name: COPY.close }));
    // O QR: "Cancelar pedido" e depois o seletor.
    await userEvent.press(screen.getByRole('button', { name: COPY.cancelRequest }));
    await userEvent.press(await screen.findByRole('radio', { name: 'QR code' }));
    expect(await screen.findByTestId('conectar-qr')).toBeOnTheScreen();
    expect(screen.queryByTestId('cartao-denunciar')).toBeNull();
    expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
  });
});
