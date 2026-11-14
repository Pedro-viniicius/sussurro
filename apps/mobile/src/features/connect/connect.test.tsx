import { proximityQrPayload } from '@sussurro/shared';
import { userEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, AppState, type AppStateStatus, Platform } from 'react-native';

import { COPY } from './copy';
import * as haptics from './haptics';
import { connectTiming } from './timing';
import {
  createFakeNfc,
  type FakeNfc,
  IPHONE_NFC_CAPABILITIES,
} from '../../../modules/sussurro-proximity/src/fake-nfc';
import { UNAVAILABLE_NFC_CAPABILITIES } from '../../../modules/sussurro-proximity/src/nfc';
import {
  apiError,
  BIA_TOKEN,
  CAIO_TOKEN,
  configureConnect,
  connectionRequest,
  incomingRequest,
  MY_TOKENS,
  proximityToken,
} from '../../test-utils/connect-fixtures';
import { type FakeApi, personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';

const SAVED_TIMING = { ...connectTiming };
const NFC_REQUEST = connectionRequest({ method: 'nfc' });
const CAIO_LABEL = COPY.connectWithLabel('Caio Ribeiro', 'caio.r');

const announce = jest.mocked(AccessibilityInfo.announceForAccessibility);
const focus = jest.mocked(AccessibilityInfo.sendAccessibilityEvent);

function focusedTestIds(): unknown[] {
  return focus.mock.calls.map(
    ([target]) => (target as unknown as { props?: { testID?: unknown } }).props?.testID,
  );
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function configureNfc(api: FakeApi) {
  configureConnect(api);
  api.on('POST /v1/connections/requests', { status: 201, body: NFC_REQUEST });
  api.on(`GET /v1/connections/requests/${NFC_REQUEST.id}`, { status: 200, body: NFC_REQUEST });
}

async function openConnect(options: { nfc?: FakeNfc; configure?: (api: FakeApi) => void } = {}) {
  const nfc = options.nfc ?? createFakeNfc();
  const rendered = await renderApp({
    signedInAs: personalMe(),
    initialUrl: '/pessoal/conectar',
    nfc,
    configure: options.configure ?? configureNfc,
  });
  expect(await screen.findByTestId('conectar-mostrar')).toBeOnTheScreen();
  return { ...rendered, nfc };
}

/** Outro celular encostado: o NFC lê o código. */
async function nfcRead(nfc: FakeNfc, token: string) {
  await act(async () => {
    nfc.simulateRead(proximityQrPayload(token));
    await Promise.resolve();
  });
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
  announce.mockClear();
  focus.mockClear();
  vibrate = jest.spyOn(haptics, 'vibrate').mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('Mostrar meu código: o QR e o NFC (ADR 0013 §1 e §5)', () => {
  it('NFC-01: ao abrir, emite por NFC o mesmo código do QR, com "Ou a outra pessoa toca em Ler código…"; nada é lido', async () => {
    const { nfc } = await openConnect();
    await waitFor(() => {
      expect(nfc.emitted).toBe(proximityQrPayload(MY_TOKENS[0]));
    });
    expect(screen.getByText(COPY.emitHint)).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: COPY.modeShow })).toBeChecked();
    expect(nfc.reading).toBe(false);
  });

  it('NFC-02: a renovação do token (20 s) emite o código novo, sem apagar no meio', async () => {
    const { nfc } = await openConnect();
    await waitFor(() => {
      expect(nfc.emitted).toBe(proximityQrPayload(MY_TOKENS[0]));
    });
    await advance(20_000);
    await waitFor(() => {
      expect(nfc.emitted).toBe(proximityQrPayload(MY_TOKENS[1]));
    });
    expect(nfc.emittedHistory).toEqual([
      proximityQrPayload(MY_TOKENS[0]),
      proximityQrPayload(MY_TOKENS[1]),
    ]);
  });

  it('NFC-01 / PROX-28: sair da aba apaga o código emitido; a volta emite de novo', async () => {
    const { nfc } = await openConnect();
    await waitFor(() => {
      expect(nfc.emitted).not.toBeNull();
    });
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    await waitFor(() => {
      expect(nfc.emitted).toBeNull();
    });
    expect(nfc.reading).toBe(false);
    await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
    expect(await screen.findByTestId('conectar-mostrar')).toBeOnTheScreen();
    await waitFor(() => {
      expect(nfc.emitted).not.toBeNull();
    });
  });

  it('NFC-01 / 4.3 CA3: em background para de emitir e de pedir token; ao voltar, emite de novo com o token novo', async () => {
    const setAppState = captureAppState();
    const { nfc, api } = await openConnect();
    await waitFor(() => {
      expect(nfc.emitted).toBe(proximityQrPayload(MY_TOKENS[0]));
    });
    await setAppState('background');
    expect(nfc.emitted).toBeNull();
    const issued = api.callsTo('POST /v1/proximity/tokens').length;
    await advance(30_000);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(issued);

    // O nativo apaga o código no background; a volta o emite de novo.
    await setAppState('active');
    await waitFor(() => {
      expect(nfc.emitted).toBe(proximityQrPayload(MY_TOKENS[1]));
    });
    expect(screen.getByTestId('conectar-mostrar')).toBeOnTheScreen();
  });

  it('NFC-03 / NFC-22 (S4): NFC desligado → "O NFC está desligado" com "Ligar NFC" (Ajustes); ligado nos Ajustes, emite sozinho', async () => {
    const nfc = createFakeNfc({ enabled: false });
    await openConnect({ nfc });
    expect(await screen.findByText(COPY.nfcOffTitle)).toBeOnTheScreen();
    expect(screen.queryByText(COPY.emitHint)).toBeNull();
    // O QR continua: a tela nunca depende do NFC (N1, N5).
    expect(screen.getByTestId('qr-card')).toBeOnTheScreen();
    expect(nfc.emitted).toBeNull();
    const turnOn = screen.getByRole('button', { name: COPY.turnOnNfc });
    // S4 (ux.md §11.19): o botão abre os ajustes, não liga nada sozinho.
    expect(turnOn).toHaveProp('accessibilityHint', COPY.turnOnNfcHint);
    await userEvent.press(turnOn);
    expect(nfc.settingsOpened).toBe(1);

    await act(async () => {
      nfc.simulateStateChange(true);
      await Promise.resolve();
    });
    expect(await screen.findByText(COPY.emitHint)).toBeOnTheScreen();
    await waitFor(() => {
      expect(nfc.emitted).toBe(proximityQrPayload(MY_TOKENS[0]));
    });
    // Desligado de novo: para de emitir.
    await act(async () => {
      nfc.simulateStateChange(false);
      await Promise.resolve();
    });
    expect(nfc.emitted).toBeNull();
    expect(await screen.findByText(COPY.nfcOffTitle)).toBeOnTheScreen();
  });

  it('NFC-06 (iPhone): só o QR no "Mostrar meu código" — sem a dica do NFC e sem emitir', async () => {
    const nfc = createFakeNfc(IPHONE_NFC_CAPABILITIES);
    await openConnect({ nfc });
    await advance(100);
    expect(screen.getByTestId('qr-card')).toBeOnTheScreen();
    expect(screen.queryByText(COPY.emitHint)).toBeNull();
    expect(screen.queryByText(COPY.nfcOffTitle)).toBeNull();
    expect(nfc.emittedHistory).toEqual([]);
  });

  it('NFC-06 (Expo Go, sem o módulo): só o QR e a câmera, sem NFC nenhum', async () => {
    const nfc = createFakeNfc(UNAVAILABLE_NFC_CAPABILITIES);
    await openConnect({ nfc });
    await advance(100);
    expect(screen.getByTestId('qr-card')).toBeOnTheScreen();
    expect(screen.queryByText(COPY.emitHint)).toBeNull();
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    expect(await screen.findByText(COPY.readCameraOnlyText)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.useCamera })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: COPY.nfcTap })).toBeNull();
    expect(nfc.readStarts).toBe(0);
    expect(nfc.emittedHistory).toEqual([]);
  });
});

describe('Ler código por NFC (ADR 0013 §5)', () => {
  it('NFC-04 (Android): "Ler código" liga a leitura e para de emitir; o código lido → resolve → cartão → "Conectar" → pedido com method "nfc"; o "Aguardando" emite de novo', async () => {
    const { nfc, api } = await openConnect();
    await waitFor(() => {
      expect(nfc.emitted).not.toBeNull();
    });
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    // S3 (ux.md §11.19): o título de "Ler código" é cabeçalho.
    expect(await screen.findByRole('header', { name: COPY.readNfcTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.readNfcText)).toBeOnTheScreen();
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    expect(nfc.emitted).toBeNull();
    expect(screen.getByRole('button', { name: COPY.useCamera })).toBeOnTheScreen();

    await nfcRead(nfc, CAIO_TOKEN);
    expect(await screen.findByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledWith(COPY.codeRead);
    expect(vibrate).toHaveBeenCalledWith('read');
    expect(api.callsTo('POST /v1/proximity/resolve')[0]?.body).toEqual({ tokens: [CAIO_TOKEN] });
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
    // Com o cartão na tela, a leitura para.
    expect(nfc.reading).toBe(false);
    // O foco vai ao nome no cartão.
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toContain('cartao-nome');

    await userEvent.press(screen.getByRole('button', { name: CAIO_LABEL }));
    expect(
      await screen.findByRole('header', { name: 'Aguardando Caio confirmar' }),
    ).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')[0]?.body).toEqual({
      targetToken: CAIO_TOKEN,
      method: 'nfc',
    });
    // D7: o "Aguardando" mostra o meu QR e emite por NFC para Caio ler, pelo "Aceitar" (N7).
    expect(screen.getByTestId('qr-card')).toBeOnTheScreen();
    expect(screen.getByText(COPY.waitingEmitHint('Caio'))).toBeOnTheScreen();
    expect(screen.queryByText(COPY.emitHint)).toBeNull();
    await waitFor(() => {
      expect(nfc.emitted).not.toBeNull();
    });
  });

  it('NFC-04: "Cancelar" no cartão volta à leitura, com o foco no início, e nada é enviado', async () => {
    const { nfc, api } = await openConnect();
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    await nfcRead(nfc, CAIO_TOKEN);
    await screen.findByRole('header', { name: 'Caio Ribeiro' });
    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(await screen.findByTestId('conectar-ler')).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toContain('conectar-titulo');
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });

  it('4.7 CA4 (NFC): o código lido que o servidor não reconhece → aviso na tela e nada é criado; "read_failed" também avisa', async () => {
    const { nfc, api } = await openConnect();
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    await nfcRead(nfc, 'VencidoTokenGGG1');
    expect(await screen.findByTestId('conectar-ler-aviso')).toHaveTextContent(COPY.qrInvalid);
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);

    await act(async () => {
      nfc.simulateReadError('read_failed');
      await Promise.resolve();
    });
    expect(screen.getByTestId('conectar-ler-aviso')).toHaveTextContent(COPY.nfcReadFailed);
  });

  it('NFC-06 / NFC-21 (S2, iPhone): o aviso de "Ler código" é anunciado (o VoiceOver ignora a região viva)', async () => {
    const nfc = createFakeNfc(IPHONE_NFC_CAPABILITIES);
    await openConnect({ nfc });
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    await userEvent.press(await screen.findByRole('button', { name: COPY.nfcTap }));
    announce.mockClear();
    await act(async () => {
      nfc.simulateReadError('read_failed');
      await Promise.resolve();
    });
    expect(await screen.findByTestId('conectar-ler-aviso')).toHaveTextContent(COPY.nfcReadFailed);
    expect(announce).toHaveBeenCalledWith(COPY.nfcReadFailed);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('NFC-21 (S2, Android): o aviso de "Ler código" fica com a região viva, sem anúncio a mais', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const { nfc } = await openConnect();
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    announce.mockClear();
    await act(async () => {
      nfc.simulateReadError('read_failed');
      await Promise.resolve();
    });
    const notice = await screen.findByTestId('conectar-ler-aviso');
    expect(notice).toHaveTextContent(COPY.nfcReadFailed);
    expect(notice).toHaveProp('accessibilityLiveRegion', 'polite');
    expect(announce).not.toHaveBeenCalledWith(COPY.nfcReadFailed);
  });

  it('NFC-23 (S5): a linha do "Código lido" não tem região viva (o anúncio sai uma vez, pelo announce)', async () => {
    const { nfc } = await openConnect({
      configure: (api) => {
        configureNfc(api);
        // O resolve não responde: a linha do spinner fica na tela.
        api.on('POST /v1/proximity/resolve', () => new Promise<never>(() => undefined));
      },
    });
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    await nfcRead(nfc, CAIO_TOKEN);
    const row = await screen.findByTestId('conectar-lendo');
    expect(row).toHaveTextContent(COPY.codeRead);
    expect(row.props.accessibilityLiveRegion).toBeUndefined();
    expect(announce).toHaveBeenCalledWith(COPY.codeRead);
  });

  it('NFC-06 (iPhone): "Ler código" mostra "Aproximar do outro celular" e "Usar a câmera"; o botão abre a folha do sistema; "cancelled" e "timeout" são silenciosos', async () => {
    const nfc = createFakeNfc(IPHONE_NFC_CAPABILITIES);
    const { api } = await openConnect({ nfc });
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    expect(await screen.findByRole('button', { name: COPY.nfcTap })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: COPY.readIphoneTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.readIphoneText)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.useCamera })).toBeOnTheScreen();
    // Sem leitura contínua: só pelo botão.
    expect(nfc.readStarts).toBe(0);

    await userEvent.press(screen.getByRole('button', { name: COPY.nfcTap }));
    expect(nfc.readStarts).toBe(1);
    for (const code of ['cancelled', 'timeout'] as const) {
      await act(async () => {
        nfc.simulateReadError(code);
        await Promise.resolve();
      });
    }
    expect(screen.queryByTestId('conectar-ler-aviso')).toBeNull();

    await userEvent.press(screen.getByRole('button', { name: COPY.nfcTap }));
    await nfcRead(nfc, CAIO_TOKEN);
    await userEvent.press(await screen.findByRole('button', { name: CAIO_LABEL }));
    await screen.findByRole('header', { name: 'Aguardando Caio confirmar' });
    expect(api.callsTo('POST /v1/connections/requests')[0]?.body).toEqual({
      targetToken: CAIO_TOKEN,
      method: 'nfc',
    });
  });

  it('NFC-03 (Ler, Android): NFC desligado → "Ligar NFC" e a câmera; nada é lido até ligar', async () => {
    const nfc = createFakeNfc({ enabled: false });
    await openConnect({ nfc });
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    expect(await screen.findByText(COPY.nfcOffTitle)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.useCamera })).toBeOnTheScreen();
    expect(nfc.readStarts).toBe(0);
    await act(async () => {
      nfc.simulateStateChange(true);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
  });

  it('corrida A→B ∥ B→A: com o cartão de Caio na tela, o pedido dele chega; "Aceitar" usa o código já lido (D7), sem ler de novo', async () => {
    const caioIncoming = incomingRequest({
      id: '01a189e0-af57-7000-85fe-2054e618fe09',
      method: 'nfc',
      other: { handle: 'caio.r', name: 'Caio Ribeiro', avatarUrl: null },
    });
    let arrived = false;
    const { nfc, api } = await openConnect({
      configure: (fake) => {
        configureNfc(fake);
        let accepted = false;
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: arrived && !accepted ? [caioIncoming] : [] },
        }));
        fake.on(`POST /v1/connections/requests/${caioIncoming.id}/accept`, () => {
          accepted = true;
          return { status: 200, body: { ...caioIncoming, status: 'accepted', expiresInS: 0 } };
        });
      },
    });
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    await nfcRead(nfc, CAIO_TOKEN);
    await screen.findByRole('button', { name: CAIO_LABEL });
    arrived = true;
    expect(await screen.findByRole('header', { name: 'Caio quer se conectar' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(
      await screen.findByRole('header', { name: 'Você e Caio estão conectados' }),
    ).toBeOnTheScreen();
    expect(api.callsTo(`POST /v1/connections/requests/${caioIncoming.id}/accept`)[0]?.body).toEqual(
      { observedToken: CAIO_TOKEN },
    );
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });

  it('NFC-04: com a folha do pedido por cima, o modo "Ler código" não lê para pedir', async () => {
    const { nfc, api } = await openConnect({
      configure: (fake) => {
        configureNfc(fake);
        fake.on('GET /v1/connections/requests/incoming', {
          status: 200,
          body: { items: [incomingRequest()] },
        });
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    expect(nfc.reading).toBe(false);
    await nfcRead(nfc, BIA_TOKEN);
    expect(api.callsTo('POST /v1/proximity/resolve')).toHaveLength(0);
  });
});

describe('Aguardando e o fim do pedido (p13 a p15)', () => {
  async function waitingFor(configure: (api: FakeApi) => void) {
    const nfc = createFakeNfc();
    const rendered = await openConnect({ nfc, configure });
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    await nfcRead(nfc, CAIO_TOKEN);
    await userEvent.press(await screen.findByRole('button', { name: CAIO_LABEL }));
    await screen.findByRole('header', { name: 'Aguardando Caio confirmar' });
    return rendered;
  }

  it('Caio confirma (polling) → "Você e Caio estão conectados", com o foco no título e o anúncio depois', async () => {
    let status = 'pending';
    await waitingFor((fake) => {
      configureNfc(fake);
      fake.on(`GET /v1/connections/requests/${NFC_REQUEST.id}`, () => ({
        status: 200,
        body: { ...NFC_REQUEST, status },
      }));
    });
    status = 'accepted';
    expect(
      await screen.findByRole('header', { name: 'Você e Caio estão conectados' }),
    ).toBeOnTheScreen();
    expect(vibrate).toHaveBeenCalledWith('connected');
  });

  it('Caio recusa ou o pedido vence → "Caio não confirmou"; "Tentar de novo" volta a "Ler código"', async () => {
    let status = 'pending';
    const { nfc } = await waitingFor((fake) => {
      configureNfc(fake);
      fake.on(`GET /v1/connections/requests/${NFC_REQUEST.id}`, () => ({
        status: 200,
        body: { ...NFC_REQUEST, status },
      }));
    });
    status = 'declined';
    expect(await screen.findByRole('header', { name: 'Caio não confirmou' })).toBeOnTheScreen();
    expect(nfc.emitted).toBeNull();
    await userEvent.press(screen.getByRole('button', { name: COPY.tryAgain }));
    expect(await screen.findByTestId('conectar-ler')).toBeOnTheScreen();
  });

  it('"Cancelar pedido" → volta ao início; o pedido é apagado no servidor', async () => {
    const { api } = await waitingFor((fake) => {
      configureNfc(fake);
      fake.on(`DELETE /v1/connections/requests/${NFC_REQUEST.id}`, {
        status: 200,
        body: { ...NFC_REQUEST, status: 'cancelled' },
      });
    });
    await userEvent.press(screen.getByRole('button', { name: COPY.cancelRequest }));
    expect(await screen.findByTestId('conectar-ler')).toBeOnTheScreen();
    expect(api.callsTo(`DELETE /v1/connections/requests/${NFC_REQUEST.id}`)).toHaveLength(1);
  });
});

describe('Conectar: erros e ciclo de vida (estados 18 a 20)', () => {
  it('4.2 CA5: Redis fora (503) → "Conectar está indisponível agora", sem emitir; "Tentar de novo" volta ao início com o foco', async () => {
    let down = true;
    const nfc = createFakeNfc();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      nfc,
      configure: (fake) => {
        configureNfc(fake);
        fake.on('POST /v1/proximity/tokens', () =>
          down ? apiError(503, 'PROXIMITY_UNAVAILABLE') : { status: 201, body: proximityToken(0) },
        );
      },
    });
    expect(await screen.findByRole('header', { name: COPY.unavailableTitle })).toBeOnTheScreen();
    expect(nfc.emitted).toBeNull();
    down = false;
    await userEvent.press(screen.getByRole('button', { name: COPY.tryAgain }));
    expect(await screen.findByTestId('conectar-mostrar')).toBeOnTheScreen();
    await advance(connectTiming.focusDelayMs);
    expect(focusedTestIds()).toContain('conectar-titulo');
    await waitFor(() => {
      expect(nfc.emitted).toBe(proximityQrPayload(MY_TOKENS[0]));
    });
  });

  it('estado 20 (bloqueio de 15 min, PROX-20): 429 nos tokens → "Muitas tentativas" (T22), sem emitir', async () => {
    const nfc = createFakeNfc();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      nfc,
      configure: (fake) => {
        configureNfc(fake);
        fake.on('POST /v1/proximity/tokens', apiError(429, 'RATE_LIMITED'));
      },
    });
    expect(await screen.findByRole('header', { name: COPY.pausedTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.pausedText)).toBeOnTheScreen();
    expect(nfc.emitted).toBeNull();
  });

  it('estado 20: 429 no resolve do código lido → "Muitas tentativas", e a leitura para', async () => {
    const { nfc } = await openConnect({
      configure: (fake) => {
        configureNfc(fake);
        fake.on('POST /v1/proximity/resolve', apiError(429, 'RATE_LIMITED'));
      },
    });
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    await nfcRead(nfc, CAIO_TOKEN);
    expect(await screen.findByRole('header', { name: COPY.pausedTitle })).toBeOnTheScreen();
    expect(nfc.reading).toBe(false);
  });

  it('estado 18: sem rede ao pedir o token → "Sem internet"', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureNfc(fake);
        fake.on('POST /v1/proximity/tokens', () => {
          throw new Error('sem rede');
        });
      },
    });
    expect(await screen.findByRole('header', { name: COPY.offlineTitle })).toBeOnTheScreen();
  });

  it('X.3: e-mail não confirmado → aviso com "Verificar e-mail", sem pedir token nem emitir', async () => {
    const nfc = createFakeNfc();
    const { api } = await renderApp({
      signedInAs: personalMe({ emailVerified: false }),
      initialUrl: '/pessoal/conectar',
      nfc,
      configure: configureNfc,
    });
    expect(await screen.findByRole('header', { name: COPY.emailTitle })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.verifyEmail })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(0);
    expect(nfc.emittedHistory).toEqual([]);
  });

  it('409 de tela fechada: renova o token e repete o resolve uma vez', async () => {
    let closed = true;
    const { nfc, api } = await openConnect({
      configure: (fake) => {
        configureNfc(fake);
        fake.on('POST /v1/proximity/resolve', () => {
          if (closed) {
            closed = false;
            return apiError(409, 'PROXIMITY_SCREEN_CLOSED');
          }
          return {
            status: 200,
            body: {
              items: [
                {
                  token: CAIO_TOKEN,
                  handle: 'caio.r',
                  name: 'Caio Ribeiro',
                  avatarUrl: null,
                  alreadyConnected: false,
                },
              ],
            },
          };
        });
      },
    });
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    await waitFor(() => {
      expect(nfc.reading).toBe(true);
    });
    const issued = api.callsTo('POST /v1/proximity/tokens').length;
    await nfcRead(nfc, CAIO_TOKEN);
    expect(await screen.findByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/proximity/resolve')).toHaveLength(2);
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(issued + 1);
  });
});
