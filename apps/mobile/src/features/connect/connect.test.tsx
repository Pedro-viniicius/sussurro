import { userEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, AppState, type AppStateStatus, Linking } from 'react-native';

import { COPY } from './copy';
import * as haptics from './haptics';
import { connectTiming } from './timing';
import { TOUCH_CALIBRATION } from './touch-calibration';
import { resetTouchReportGate } from './useTouch';
import {
  createFakeRadio,
  type FakeRadio,
} from '../../../modules/sussurro-proximity/src/fake-radio';
import {
  apiError,
  BIA_TOKEN,
  CAIO_TOKEN,
  configureConnect,
  connectionRequest,
  incomingRequest,
  MY_BLE_TOKENS,
  MY_QR_TOKENS,
  mutualTouches,
  nearbyPerson,
  touchItem,
} from '../../test-utils/connect-fixtures';
import { type FakeApi, type FakeReply, personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';

const SAVED_TIMING = { ...connectTiming };
const CAL = TOUCH_CALIBRATION;
const REQUEST = connectionRequest();
const CAIO = nearbyPerson();
/** A referência única de todo emissor (adendo A1): RSSI = referência − perda. */
const TX_REF = TOUCH_CALIBRATION.advertiserTxDbm;
const CAIO_LABEL = COPY.connectWithLabel('Caio Ribeiro', 'caio.r');

const announce = jest.mocked(AccessibilityInfo.announceForAccessibility);
const queued = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
const focus = jest.mocked(AccessibilityInfo.sendAccessibilityEvent);

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/**
 * O `testID` de cada elemento que recebeu o foco, na ordem. O `ref` é a instância do `View`, não o
 * elemento da árvore de teste, então a comparação é pelo `testID` (sem imprimir a instância).
 */
function focusedTestIds(): unknown[] {
  return focus.mock.calls.map(
    ([target]) => (target as unknown as { props?: { testID?: unknown } }).props?.testID,
  );
}

/** O tempo até sair o anúncio que acompanha o foco (ux.md §11.8). */
function afterFocus() {
  return connectTiming.focusDelayMs + connectTiming.announceAfterFocusMs;
}

/**
 * ux.md §11.8: primeiro o foco (em `focusedTestId`), depois o anúncio, em fila, uma vez só e nunca
 * na hora (a leitura do elemento focado cortaria o anúncio).
 */
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
  // O foco no elemento certo veio antes do anúncio.
  expect(focusedAt.some((order) => order < announcedAt)).toBe(true);
  expect(announce).not.toHaveBeenCalledWith(message);
}

/** Anúncios a cada 200 ms durante `ms`, com a perda pedida. */
async function sight(radio: FakeRadio, ms: number, token: string, loss: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += CAL.sightingMinIntervalMs) {
    await act(async () => {
      radio.emitSighting(token, TX_REF - loss);
      await jest.advanceTimersByTimeAsync(CAL.sightingMinIntervalMs);
    });
  }
}

/** Encosta: perda de encosto por ~1,4 s (3 amostras + 0,7 s sustentado). */
async function touch(radio: FakeRadio, token = CAIO_TOKEN) {
  await sight(radio, 1400, token, 30);
}

function configureTouch(api: FakeApi) {
  configureConnect(api);
  api.on('POST /v1/proximity/touches', mutualTouches({ [CAIO_TOKEN]: CAIO }));
}

async function openReady(options: { radio?: FakeRadio; configure?: (api: FakeApi) => void } = {}) {
  const radio = options.radio ?? createFakeRadio();
  const rendered = await renderApp({
    signedInAs: personalMe(),
    initialUrl: '/pessoal/conectar',
    radio,
    configure: options.configure ?? configureTouch,
  });
  expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  await waitFor(() => {
    expect(radio.scanning).toBe(true);
  });
  return { ...rendered, radio };
}

/** Encosta e espera o cartão de Caio (o 2º relato traz o cartão). */
async function openCard(radio: FakeRadio) {
  await touch(radio);
  expect(await screen.findByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
}

/** Captura os ouvintes do AppState para o teste mandar o app ao background e de volta. */
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

let vibrate: jest.SpyInstance;

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, tickMs: 20 });
  // O ritmo e o orçamento do relato ficam no módulo (ADR 0012, A2 rev. 1, R1-3).
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

describe('Conectar encostando (ADR 0012, ux.md §11)', () => {
  it('P7 / D-UX21: a aba abre pronta, sem botão; anuncia só o bleToken (potência HIGH, sem o campo TX) e varre', async () => {
    const { radio, api } = await openReady();
    // Pronto (6): T1, seletor "Encostar | QR code", T4, T5 e a nota T43.
    expect(screen.getByText(COPY.intro)).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Encostar' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'QR code' })).not.toBeChecked();
    expect(screen.getByText(COPY.readyText)).toBeOnTheScreen();
    expect(screen.getByText(COPY.privacyNote)).toBeOnTheScreen();
    expect(screen.getByTestId('conectar-pronto')).toBeOnTheScreen();
    // A ilustração é decorativa: fora do leitor de tela.
    expect(screen.queryByTestId('ilustracao-encostar')).toBeNull();
    expect(screen.getByTestId('ilustracao-encostar', { includeHiddenElements: true })).toBeTruthy();

    await waitFor(() => {
      expect(radio.advertising).toBe(MY_BLE_TOKENS[0]);
    });
    expect(radio.advertiseOptions).toStrictEqual({ txPower: 'high' });
    // O qrToken nunca vai ao ar (ADR 0012 §1).
    expect(radio.advertised).not.toContain(MY_QR_TOKENS[0]);
    expect(radio.scanMinIntervalMs).toBe(CAL.sightingMinIntervalMs);
    expect(radio.keepScreenOn).toBe(true);
    // Antes de encostar, ninguém é relatado.
    expect(api.callsTo('POST /v1/proximity/touches')).toHaveLength(0);
    // ux.md §11.8: na abertura, a ordem normal vale (o foco não salta para o título do estado).
    await advance(1000);
    expect(focusedTestIds()).toEqual([]);
  });

  it('11.4 / A3: Aproximando → Confirmando → cartão; vibra só no cartão; A1, A2, e o A3 depois do foco no nome; o pedido usa o bleToken do cartão', async () => {
    let polls = 0;
    const { radio, api } = await openReady({
      configure: (fake) => {
        configureTouch(fake);
        fake.on('POST /v1/connections/requests', { status: 201, body: REQUEST });
        fake.on(`GET /v1/connections/requests/${REQUEST.id}`, () => {
          polls += 1;
          return {
            status: 200,
            body: connectionRequest({ status: polls >= 2 ? 'accepted' : 'pending' }),
          };
        });
      },
    });

    // Aproximando (7): "Quase lá", sem nenhum dado de ninguém.
    await sight(radio, 800, CAIO_TOKEN, 48);
    expect(await screen.findByRole('header', { name: COPY.approachingTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.approachingText)).toBeOnTheScreen();
    expect(screen.getByTestId('conectar-aproximando')).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(COPY.announceApproaching);
    expect(screen.queryByText(/Caio/)).toBeNull();

    // Confirmando (8): "Encostou!" e "Segurem…"; ainda sem vibrar (o NameDrop, D-UX24).
    await touch(radio);
    expect(await screen.findByRole('header', { name: COPY.confirmingTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.confirmingText)).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(COPY.announceConfirming);
    expect(vibrate).not.toHaveBeenCalled();

    // Cartão (11): o 2º relato traz o cartão (revelação simétrica).
    await advance(CAL.reportEveryMs);
    expect(await screen.findByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(screen.getByText('@caio.r')).toBeOnTheScreen();
    expect(screen.getByText(COPY.cardCheck)).toBeOnTheScreen();
    expect(screen.getByText(COPY.connectWith('Caio'))).toBeOnTheScreen();
    // Sem a introdução e sem o seletor.
    expect(screen.queryByText(COPY.intro)).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Encostar' })).toBeNull();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith('touched');
    // Estado 11: a tela fica acesa (o cartão tem prazo).
    expect(radio.keepScreenOn).toBe(true);
    // A3 (ux.md §11.8): primeiro o foco no nome, depois o anúncio, em fila.
    await advance(afterFocus());
    expect(focusedTestIds()).toContain('cartao-nome');
    expectAnnouncedAfterFocus(COPY.announceTouched('Caio Ribeiro'), 'cartao-nome');
    // PROX-43: os relatos só levam o bleToken.
    for (const call of api.callsTo('POST /v1/proximity/touches')) {
      expect(call.body).toEqual({ tokens: [CAIO_TOKEN] });
    }
    // O cartão não some quando os celulares se afastam; com ele na tela, nada é relatado (P8).
    const reports = api.callsTo('POST /v1/proximity/touches').length;
    await touch(radio, BIA_TOKEN);
    await advance(3000);
    expect(api.callsTo('POST /v1/proximity/touches')).toHaveLength(reports);
    expect(screen.getByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: CAIO_LABEL }));
    expect(
      await screen.findByRole('header', { name: 'Aguardando Caio confirmar' }),
    ).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')[0]?.body).toEqual({
      targetToken: CAIO_TOKEN,
      method: 'ble',
    });
    expect(radio.keepScreenOn).toBe(true);

    expect(
      await screen.findByRole('header', { name: 'Você e Caio estão conectados' }),
    ).toBeOnTheScreen();
    expect(vibrate).toHaveBeenLastCalledWith('connected');
    // "Vocês estão conectados": depois do foco no título do p14, em fila.
    await advance(afterFocus());
    expectAnnouncedAfterFocus(COPY.announceConnected, 'conectados-titulo');
    // "Conectar outra pessoa" some da tela: o foco vai ao título do Pronto (ux.md §11.8).
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.connectAnother }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toContain('conectar-titulo');
    // Uma sessão de varredura só, do começo ao fim da visita à aba (P7).
    expect(radio.scanStarts).toBe(1);
  });

  it('P4 / estado 17: o cartão vence aos 55 s → Toast T20 e volta ao Pronto, sem pedido; o T20 sai uma vez, depois do foco no título', async () => {
    const { radio, api } = await openReady();
    await openCard(radio);
    await advance(55_000 - 1500);
    expect(screen.getByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    focus.mockClear();
    await advance(1500);
    expect(await screen.findByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(screen.queryByRole('header', { name: 'Caio Ribeiro' })).toBeNull();
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
    // ux.md §11.4 e §11.8: o próprio Toast anuncia (sem anúncio extra), depois do foco e em fila.
    await advance(afterFocus());
    expect(focusedTestIds()).toContain('conectar-titulo');
    expectAnnouncedAfterFocus(COPY.cardExpired('Caio'), 'conectar-titulo');
  });

  it('estado 17: o pedido recusado pelo par vencido (400 genérico) → o mesmo "o tempo acabou"', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        configureTouch(fake);
        fake.on('POST /v1/connections/requests', apiError(400, 'PROXIMITY_TOKEN_INVALID'));
      },
    });
    await openCard(radio);
    await userEvent.press(screen.getByRole('button', { name: CAIO_LABEL }));
    expect(await screen.findByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  });

  it('A2-2 / PROX-51 / PROX-70 (estado 22): cartão devido com token que não serve → o cartão sem Conectar; nenhum pedido sai com esse token, e a tela não para', async () => {
    const NEVER_ISSUED = 'NeverIssuedTok01';
    const { radio, api } = await openReady({
      configure: (fake) => {
        configureConnect(fake);
        // O cartão devido chega com um token que nunca foi emitido (ADR 0012, A2-2, regra do rótulo).
        fake.on(
          'POST /v1/proximity/touches',
          mutualTouches({ [CAIO_TOKEN]: nearbyPerson({ token: NEVER_ISSUED }) }),
        );
        fake.on('POST /v1/connections/requests', apiError(400, 'PROXIMITY_TOKEN_INVALID'));
      },
    });
    await openCard(radio);
    expect(screen.getByTestId('conectar-encostado-sem-conectar')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: CAIO_LABEL })).toBeNull();
    expect(screen.getByText(COPY.noConnectCardText('Caio'))).toBeOnTheScreen();
    await advance(55_000 + 1000);
    // Vence como o 11 (17), sem nenhum pedido e sem parar a tela.
    expect(await screen.findByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
    expect(screen.getByTestId('conectar-pronto')).toBeOnTheScreen();
  });

  it('erro de rede no "Conectar": Toast e o cartão continua para tentar de novo', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        configureTouch(fake);
        fake.on('POST /v1/connections/requests', () => {
          throw new Error('sem rede');
        });
      },
    });
    await openCard(radio);
    await userEvent.press(screen.getByRole('button', { name: CAIO_LABEL }));
    expect(await screen.findByText(/Sem conexão com a internet/)).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
  });

  it('estado 12 / A4: quem já é conexão → "Vocês já estão conectados." com Voltar; sem prazo, sem T20 e sem tela acesa', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        configureConnect(fake);
        fake.on(
          'POST /v1/proximity/touches',
          mutualTouches({ [CAIO_TOKEN]: nearbyPerson({ alreadyConnected: true }) }),
        );
      },
    });
    await openCard(radio);
    expect(screen.getByTestId('conectar-encostado-conectados')).toBeOnTheScreen();
    expect(screen.getByText(COPY.alreadyConnected)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: CAIO_LABEL })).toBeNull();
    await advance(afterFocus());
    expectAnnouncedAfterFocus(COPY.announceTouchedConnected('Caio Ribeiro'), 'cartao-nome');
    // ux.md §11.4 (estado 12, §11.13 R4): a tela não fica acesa e o cartão não vence.
    expect(radio.keepScreenOn).toBe(false);
    await advance(60_000);
    expect(screen.getByTestId('conectar-encostado-conectados')).toBeOnTheScreen();
    expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
    expect(queued).not.toHaveBeenCalledWith(COPY.cardExpired('Caio'), expect.anything());
    expect(announce).not.toHaveBeenCalledWith(COPY.cardExpired('Caio'));
    // "Voltar" some da tela: o foco vai ao título do Pronto.
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.back }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toContain('conectar-titulo');
  });

  it('R8 / estado 12: 409 ALREADY_CONNECTED no "Conectar" → o cartão vira o estado 12 (A4 depois do foco, sem Toast) e não vence mais', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        configureTouch(fake);
        fake.on('POST /v1/connections/requests', apiError(409, 'ALREADY_CONNECTED'));
      },
    });
    await openCard(radio);
    await advance(afterFocus());
    focus.mockClear();
    queued.mockClear();
    await userEvent.press(screen.getByRole('button', { name: CAIO_LABEL }));
    expect(await screen.findByTestId('conectar-encostado-conectados')).toBeOnTheScreen();
    expect(screen.queryByTestId('toast')).toBeNull();
    await advance(afterFocus());
    expect(focusedTestIds()).toContain('cartao-nome');
    expectAnnouncedAfterFocus(COPY.announceTouchedConnected('Caio Ribeiro'), 'cartao-nome');
    expect(radio.keepScreenOn).toBe(false);
    await advance(60_000);
    expect(screen.getByTestId('conectar-encostado-conectados')).toBeOnTheScreen();
    expect(screen.queryByText(COPY.cardExpired('Caio'))).toBeNull();
  });

  it('"Cancelar" no cartão volta ao Pronto (a demonstração roda de novo) com o foco no título; a volta do background não mexe no foco', async () => {
    const setAppState = captureAppState();
    const { radio } = await openReady();
    await openCard(radio);
    await advance(afterFocus());
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toEqual(['conectar-titulo']);

    // ux.md §11.8: na volta do background, o foco fica onde estava.
    focus.mockClear();
    await setAppState('background');
    await advance(1000);
    await setAppState('active');
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await advance(1000);
    expect(screen.getByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(focusedTestIds()).toEqual([]);
  });

  it('P3 / estado 9: "Não deu para confirmar" aos 7 s; o casamento até 8 s depois ainda abre o cartão', async () => {
    // O 1º relato responde em 3 s (o relato vai até 11 s); o cartão vem no relato dos 8 s.
    let calls = 0;
    const { radio } = await openReady({
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/touches', () => {
          calls += 1;
          if (calls === 1) {
            return new Promise<FakeReply>((resolve) => {
              setTimeout(() => {
                resolve({ status: 200, body: { items: [] } });
              }, 3000);
            });
          }
          return { status: 200, body: { items: calls >= 7 ? [touchItem(CAIO)] : [] } };
        });
      },
    });
    await touch(radio);
    await advance(CAL.confirmWarnAfterMs);
    expect(await screen.findByText(COPY.touchFailed)).toBeOnTheScreen();
    expect(screen.getByTestId('conectar-nao-deu')).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(COPY.touchFailed);
    await advance(1200);
    expect(await screen.findByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
  });

  it('P9 / estado 10: 20 s sem encostar → "Não está dando certo?" com o QR em destaque (A6 uma vez)', async () => {
    await openReady();
    await advance(CAL.noTouchFallbackMs - 1000);
    expect(screen.queryByTestId('conectar-dica-qr')).toBeNull();
    await advance(1200);
    expect(await screen.findByTestId('conectar-dica-qr')).toBeOnTheScreen();
    expect(screen.getByText(COPY.nobodyTitle)).toBeOnTheScreen();
    expect(screen.getByText(COPY.nobodyText)).toBeOnTheScreen();
    // O bloco entra no lugar do T5 e da nota T43.
    expect(screen.queryByText(COPY.readyText)).toBeNull();
    expect(screen.queryByText(COPY.privacyNote)).toBeNull();
    await advance(10_000);
    expect(announce.mock.calls.filter(([text]) => text === COPY.announceNoTouch)).toHaveLength(1);
    await userEvent.press(screen.getByRole('button', { name: COPY.useQr }));
    expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'QR code' })).toBeChecked();
  });

  it('PROX-28: no QR o celular não anuncia nem varre; voltar ao Encostar recomeça no Pronto', async () => {
    const { radio } = await openReady();
    await userEvent.press(screen.getByRole('radio', { name: 'QR code' }));
    expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    expect(radio.advertising).toBeNull();
    await userEvent.press(screen.getByRole('radio', { name: 'Encostar' }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await waitFor(() => {
      expect(radio.advertising).not.toBeNull();
    });
  });

  it('ux.md §11.8 / WCAG 3.2.2: pelo seletor, o seletor continua montado e o foco não salta para o título do Pronto', async () => {
    await openReady();
    const group = screen.getByTestId('seletor-conectar');
    const touchSegment = screen.getByRole('radio', { name: 'Encostar' });
    const qrSegment = screen.getByRole('radio', { name: 'QR code' });
    focus.mockClear();

    await userEvent.press(qrSegment);
    expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
    expect(screen.getByTestId('seletor-conectar') === group).toBe(true);
    expect(screen.getByRole('radio', { name: 'QR code' }) === qrSegment).toBe(true);
    // A introdução (T1) é só do Encostar.
    expect(screen.queryByText(COPY.intro)).toBeNull();

    await userEvent.press(touchSegment);
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.intro)).toBeOnTheScreen();
    expect(screen.getByTestId('seletor-conectar') === group).toBe(true);
    expect(screen.getByRole('radio', { name: 'Encostar' }) === touchSegment).toBe(true);
    expect(touchSegment).toBeChecked();
    await advance(1000);
    expect(focusedTestIds()).toEqual([]);
  });
});

describe('Conectar: estados do Bluetooth (ux.md §11.4, 2 a 5)', () => {
  it('estado 2: permissão nunca pedida → explicação (T23) antes do pedido do sistema; permitido → Pronto', async () => {
    const radio = createFakeRadio({ permission: 'undetermined' });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureTouch,
    });
    expect(await screen.findByRole('header', { name: COPY.btExplainTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.btExplainText)).toBeOnTheScreen();
    // Nada de pedido do sistema nem de varredura sem a explicação (P7).
    expect(radio.permissionRequests).toBe(0);
    expect(radio.scanning).toBe(false);
    await userEvent.press(screen.getByRole('button', { name: COPY.continue }));
    expect(radio.permissionRequests).toBe(1);
    // "Continuar" some da tela: o foco vai ao título do Pronto (ux.md §11.8).
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toContain('conectar-titulo');
  });

  it('estado 3: negado → T25 com "Abrir Ajustes" e "Usar QR code"', async () => {
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const radio = createFakeRadio({ permission: 'denied', canAskAgain: false });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureTouch,
    });
    expect(await screen.findByRole('header', { name: COPY.btDeniedTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.btDeniedText)).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.openSettings }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    await userEvent.press(screen.getByRole('button', { name: COPY.useQr }));
    expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
  });

  it('estado 3 → 6: permitiu nos Ajustes; na volta, o Pronto aparece com o foco no título (ux.md §11.8)', async () => {
    const setAppState = captureAppState();
    jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const radio = createFakeRadio({ permission: 'denied', canAskAgain: false });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureTouch,
    });
    await userEvent.press(await screen.findByRole('button', { name: COPY.openSettings }));
    await setAppState('background');
    radio.capabilities = { ...radio.capabilities, permission: 'granted' };
    await setAppState('active');
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toContain('conectar-titulo');
  });

  it('estado 4: Bluetooth desligado → T26; ao ligar, o Pronto volta sozinho', async () => {
    const radio = createFakeRadio({ bluetooth: 'off' });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureTouch,
    });
    expect(await screen.findByRole('header', { name: COPY.btOffTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.btOffText)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.useQr })).toBeOnTheScreen();
    await act(async () => {
      radio.emitState('on');
      await Promise.resolve();
    });
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  });

  it('estado 4b: Android ≤ 11 com a localização desligada → T27 com "Abrir Ajustes" e o QR', async () => {
    const radio = createFakeRadio({ locationServices: 'off' });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureTouch,
    });
    expect(await screen.findByRole('header', { name: COPY.locationOffTitle })).toBeOnTheScreen();
    expect(screen.getByTestId('bt-localizacao')).toBeOnTheScreen();
    expect(screen.getByText(COPY.locationOffText)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.useQr })).toBeOnTheScreen();
    expect(radio.scanning).toBe(false);
  });

  it.each([
    ['sem o módulo nativo', { available: false, bleSupported: false, bluetooth: 'unsupported' }],
    ['P6: não consegue anunciar', { canAdvertise: false }],
  ] as const)(
    'estado 5 (%s): a aba abre no QR com a faixa T30; "Encostar" mostra T28/T29',
    async (_case, caps) => {
      const radio = createFakeRadio(caps);
      await renderApp({
        signedInAs: personalMe(),
        initialUrl: '/pessoal/conectar',
        radio,
        configure: configureTouch,
      });
      expect(await screen.findByText(COPY.unsupportedBanner)).toBeOnTheScreen();
      expect(screen.getByRole('radio', { name: 'QR code' })).toBeChecked();
      expect(radio.scanning).toBe(false);
      expect(radio.advertising).toBeNull();
      await userEvent.press(screen.getByRole('radio', { name: 'Encostar' }));
      expect(
        await screen.findByRole('header', { name: COPY.btUnavailableTitle }),
      ).toBeOnTheScreen();
      expect(screen.getByTestId('conectar-sem-suporte')).toBeOnTheScreen();
      expect(screen.getByText(COPY.btUnavailableText)).toBeOnTheScreen();
      await userEvent.press(screen.getByRole('button', { name: COPY.useQr }));
      expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
    },
  );
});

describe('Conectar: erros e ciclo de vida (estados 18 a 20)', () => {
  it('4.2 CA5: Redis fora (503) → "Conectar está indisponível agora"; "Tentar de novo" volta ao Pronto', async () => {
    let down = true;
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureTouch(fake);
        fake.on('POST /v1/proximity/tokens', () =>
          down
            ? apiError(503, 'PROXIMITY_UNAVAILABLE')
            : {
                status: 201,
                body: {
                  bleToken: MY_BLE_TOKENS[0],
                  qrToken: MY_QR_TOKENS[0],
                  expiresAt: '2026-10-30T12:00:30.000Z',
                  renewInS: 20,
                },
              },
        );
      },
    });
    expect(await screen.findByRole('header', { name: COPY.unavailableTitle })).toBeOnTheScreen();
    down = false;
    await userEvent.press(screen.getByRole('button', { name: COPY.tryAgain }));
    // "Tentar de novo" some da tela: o foco vai ao título do Pronto (ux.md §11.8).
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toContain('conectar-titulo');
  });

  it('X.3: e-mail não confirmado → aviso com "Verificar e-mail", sem pedir token', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe({ emailVerified: false }),
      initialUrl: '/pessoal/conectar',
      configure: configureTouch,
    });
    expect(await screen.findByRole('header', { name: COPY.emailTitle })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.verifyEmail })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(0);
  });

  it('estado 20: 429 no relato → "Muitas tentativas" (T22); anúncio e varredura param', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/touches', apiError(429, 'RATE_LIMITED'));
      },
    });
    await touch(radio);
    expect(await screen.findByRole('header', { name: COPY.pausedTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.pausedText)).toBeOnTheScreen();
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    expect(radio.advertising).toBeNull();
  });

  it('estado 18: sem rede no Confirmando → "Sem internet" (depois de repetir o relato por 10 s, A3-3)', async () => {
    const { radio } = await openReady({
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/touches', () => {
          throw new Error('sem rede');
        });
      },
    });
    await touch(radio);
    await advance(CAL.cardRedeliveryMs);
    expect(await screen.findByRole('header', { name: COPY.offlineTitle })).toBeOnTheScreen();
  });

  /** O relato que não chega ao servidor: o `fetch` falha e vira `NetworkError`. */
  function offline(): FakeReply {
    throw new Error('sem rede');
  }

  it.each([
    ['18, sem rede', COPY.offlineTitle, offline],
    ['19, 503', COPY.unavailableTitle, () => apiError(503, 'PROXIMITY_UNAVAILABLE')],
  ] as const)(
    'PROX-68 (estado %s): o relato que falha não para a tela antes dos 10 s do 1º que falhou (o "Encostou!" e, aos 7 s, o T11); no fim da sequência, "%s"',
    async (_case, title, fail) => {
      const starts: number[] = [];
      const { radio } = await openReady({
        configure: (fake) => {
          configureConnect(fake);
          fake.on('POST /v1/proximity/touches', () => {
            starts.push(Date.now());
            return fail();
          });
        },
      });
      await touch(radio);
      const [firstAt = 0] = starts;
      expect(screen.getByRole('header', { name: COPY.confirmingTitle })).toBeOnTheScreen();
      // ux.md §11.4, estado 18 (A3-3): a fase normal segue, inclusive o T11 aos 7 s.
      await advance(firstAt + CAL.cardRedeliveryMs - 200 - Date.now());
      expect(screen.queryByRole('header', { name: title })).toBeNull();
      expect(screen.getByTestId('conectar-nao-deu')).toBeOnTheScreen();
      await advance(400);
      expect(await screen.findByRole('header', { name: title })).toBeOnTheScreen();
      // O mesmo token, um por vez, a cada 2 s, até 10 s depois do início do 1º que falhou.
      expect(starts.map((at) => at - firstAt)).toEqual([0, 2000, 4000, 6000, 8000]);
    },
  );

  it.each([
    ['sem rede na volta', offline, CAL.reportRetryEveryMs],
    ['503 depois do script', () => apiError(503, 'PROXIMITY_UNAVAILABLE'), CAL.reportRetryEveryMs],
    [
      'conexão travada até o prazo de 4 s',
      () => new Promise<FakeReply>(() => undefined),
      CAL.reportTimeoutMs,
    ],
  ] as const)(
    'PROX-68 (R23, o diagrama do A3): a resposta com o cartão se perde (%s) → o mesmo token sai de novo, a reentrega abre o 11 com o Conectar, e a tela não para',
    async (_case, lose, retryAfterMs) => {
      const sent: { at: number; token: string }[] = [];
      const { radio } = await openReady({
        configure: (fake) => {
          configureConnect(fake);
          fake.on('POST /v1/proximity/touches', ({ body }) => {
            const [token = ''] = (body as { tokens: string[] }).tokens;
            sent.push({ at: Date.now(), token });
            // 1º: o outro ainda não relatou. 2º: o servidor retira o cartão, e a resposta se perde.
            // Depois: a reentrega (A3-2), com o pairExpiresInS recalculado (50).
            if (sent.length === 1) return { status: 200, body: { items: [] } };
            if (sent.length === 2) return lose();
            return { status: 200, body: { items: [touchItem(CAIO, 50)] } };
          });
        },
      });
      await touch(radio);
      await advance(6000);
      expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
      expect(screen.getByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: CAIO_LABEL })).toBeEnabled();
      expect(sent.map((call) => call.token)).toEqual([CAIO_TOKEN, CAIO_TOKEN, CAIO_TOKEN]);
      const [first, lost, retried] = sent.map((call) => call.at);
      expect((lost ?? 0) - (first ?? 0)).toBe(CAL.reportEveryMs);
      expect((retried ?? 0) - (lost ?? 0)).toBe(retryAfterMs);
      // Com o cartão na tela, nada mais é relatado (P8), e a tela não para.
      await advance(15_000);
      expect(sent).toHaveLength(3);
      expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
      expect(screen.queryByRole('header', { name: COPY.offlineTitle })).toBeNull();
      expect(screen.queryByRole('header', { name: COPY.unavailableTitle })).toBeNull();
    },
  );

  it('4.3 CA3 / PROX-28: em background o anúncio e a varredura param; ao voltar recomeçam com o token novo', async () => {
    const setAppState = captureAppState();
    const { radio, api } = await openReady();
    await waitFor(() => {
      expect(radio.advertising).toBe(MY_BLE_TOKENS[0]);
    });
    await setAppState('background');
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    expect(radio.advertising).toBeNull();
    expect(radio.keepScreenOn).toBe(false);
    const issued = api.callsTo('POST /v1/proximity/tokens').length;
    await advance(30_000);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(issued);

    await setAppState('active');
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await waitFor(() => {
      expect(radio.advertising).toBe(MY_BLE_TOKENS[1]);
    });
    expect(screen.getByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  });

  it('PROX-28: sair da aba para o anúncio e a varredura; a volta começa no Verificando e fica pronta', async () => {
    const { radio } = await openReady();
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    expect(radio.advertising).toBeNull();
    expect(radio.keepScreenOn).toBe(false);
    await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  });

  it('pedido recebido de quem está no cartão: o cartão vira o pedido (14), com o A5 depois do foco no título; Aceitar sem token conecta', async () => {
    const helena = nearbyPerson({ token: CAIO_TOKEN, handle: 'helena', name: 'Helena Souza' });
    const request = incomingRequest();
    let pending = false;
    const { radio, api } = await openReady({
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/touches', mutualTouches({ [CAIO_TOKEN]: helena }));
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
    expect(await screen.findByRole('header', { name: 'Helena Souza' })).toBeOnTheScreen();
    pending = true;
    expect(
      await screen.findByRole('header', { name: 'Helena quer se conectar' }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('conectar-pedido-cartao')).toBeOnTheScreen();
    // No próprio cartão: sem a folha por cima.
    expect(screen.queryByTestId('folha-pedido')).toBeNull();
    expect(screen.getByTestId('cartao-prazo')).toHaveTextContent(/^Expira em [12]:\d\d$/);
    expect(vibrate).toHaveBeenCalledWith('incoming');
    await advance(afterFocus());
    expect(focusedTestIds().at(-1)).toBe('cartao-titulo');
    expectAnnouncedAfterFocus(COPY.announceIncoming('Helena'), 'cartao-titulo');
    // Depois de virar pedido, vale o prazo do pedido, não o do cartão (P4).
    await advance(10_000);
    expect(screen.getByTestId('conectar-pedido-cartao')).toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(
      await screen.findByRole('header', { name: 'Você e Helena estão conectados' }),
    ).toBeOnTheScreen();
    // ADR 0012 §4: o aceite por encostar vai sem token.
    expect(api.callsTo(`POST /v1/connections/requests/${request.id}/accept`)[0]?.body).toEqual({});
  });

  it('estado 14 → Pronto: o pedido do cartão vence → Toast, foco no título do Pronto e o anúncio do Toast depois do foco', async () => {
    const helena = nearbyPerson({ token: CAIO_TOKEN, handle: 'helena', name: 'Helena Souza' });
    const request = incomingRequest({ expiresInS: 3 });
    let pending = false;
    const { radio } = await openReady({
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/touches', mutualTouches({ [CAIO_TOKEN]: helena }));
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: pending ? [request] : [] },
        }));
      },
    });
    await touch(radio);
    expect(await screen.findByRole('header', { name: 'Helena Souza' })).toBeOnTheScreen();
    pending = true;
    expect(
      await screen.findByRole('header', { name: 'Helena quer se conectar' }),
    ).toBeOnTheScreen();
    await advance(afterFocus());
    focus.mockClear();
    await advance(3_000);
    expect(await screen.findByText(COPY.expired('Helena'))).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    await advance(afterFocus());
    expect(focusedTestIds()).toEqual(['conectar-titulo']);
    expectAnnouncedAfterFocus(COPY.expired('Helena'), 'conectar-titulo');
  });
});
