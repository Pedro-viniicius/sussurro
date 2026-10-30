import type { NearbyPerson } from '@sussurro/shared';
import { userEvent } from '@testing-library/react-native';
import { act, screen, waitFor, within } from 'expo-router/testing-library';
import { AppState, type AppStateStatus, Linking } from 'react-native';

import { COPY } from './copy';
import { connectTiming } from './timing';
import { createFakeRadio } from '../../../modules/sussurro-proximity/src/fake-radio';
import {
  apiError,
  BIA_TOKEN,
  CAIO_TOKEN,
  CAIO_TOKEN_2,
  configureConnect,
  connectionRequest,
  MY_TOKENS,
  nearbyPerson,
} from '../../test-utils/connect-fixtures';
import { type FakeApi, type FakeCall, personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';

const SAVED_TIMING = { ...connectTiming };
const REQUEST = connectionRequest();
const FAR_TOKEN = 'LongeTokenEEEEE1';

const PEOPLE: Record<string, NearbyPerson> = {
  [CAIO_TOKEN]: nearbyPerson(),
  [CAIO_TOKEN_2]: nearbyPerson({ token: CAIO_TOKEN_2 }),
  [BIA_TOKEN]: nearbyPerson({ token: BIA_TOKEN, handle: 'bia.alves', name: 'Bianca Alves' }),
  [FAR_TOKEN]: nearbyPerson({ token: FAR_TOKEN, handle: 'longe', name: 'Pessoa Longe' }),
};

function resolver({ body }: FakeCall) {
  const tokens = (body as { tokens: string[] }).tokens;
  return {
    status: 200,
    body: {
      items: tokens.flatMap((token) => (PEOPLE[token] === undefined ? [] : [PEOPLE[token]])),
    },
  };
}

function configureNearby(api: FakeApi) {
  configureConnect(api);
  api.on('POST /v1/proximity/resolve', resolver);
}

async function startSearching() {
  await userEvent.press(await screen.findByRole('button', { name: COPY.search }));
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

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, resolveMinIntervalMs: 0, tickMs: 20 });
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('Conectar por Bluetooth (4.4 e 4.5)', () => {
  it('4.4 CA1/CA8 + 4.5 CA1 + PROX-25: lista pelo sinal com as faixas; o pedido usa o token mais recente; "Conectados"', async () => {
    const radio = createFakeRadio();
    let polls = 0;
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureNearby(fake);
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

    // Inicial (p10) com o seletor "Bluetooth / QR code" (D3).
    expect(await screen.findByText(COPY.intro)).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Bluetooth' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'QR code' })).not.toBeChecked();
    expect(screen.getByText(COPY.searchHint)).toBeOnTheScreen();
    // Antes de procurar, nada é anunciado nem varrido.
    expect(radio.scanning).toBe(false);
    expect(radio.advertising).toBeNull();

    await startSearching();
    expect(await screen.findByText(COPY.searching)).toBeOnTheScreen();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await waitFor(() => {
      expect(radio.advertising).toBe(MY_TOKENS[0]);
    });
    expect(radio.keepScreenOn).toBe(true);

    await act(async () => {
      radio.emitSighting(CAIO_TOKEN, -72);
      radio.emitSighting(BIA_TOKEN, -50);
      radio.emitSighting(FAR_TOKEN, -95);
      await Promise.resolve();
    });
    expect(await screen.findByRole('header', { name: COPY.nearbyTitle })).toBeOnTheScreen();
    // Ordem pelo sinal; abaixo de -90 dBm não aparece; faixas em vez de metros (D13).
    await waitFor(() => {
      expect(screen.getAllByTestId(/^por-perto-/).map((row) => String(row.props.testID))).toEqual([
        'por-perto-bia.alves',
        'por-perto-caio.r',
      ]);
    });
    expect(screen.getByText('Bianca Alves · bem perto')).toBeOnTheScreen();
    expect(screen.getByText('Caio Ribeiro · por perto')).toBeOnTheScreen();
    expect(screen.queryByText(/Pessoa Longe/)).not.toBeOnTheScreen();
    expect(screen.getByText(COPY.nearbyFooter)).toBeOnTheScreen();

    // O token de Caio muda (20 s): o pedido vai com o mais recente (PROX-25).
    await act(async () => {
      radio.emitSighting(CAIO_TOKEN_2, -71);
      await Promise.resolve();
    });
    await waitFor(() => {
      const sent = api
        .callsTo('POST /v1/proximity/resolve')
        .flatMap((call) => (call.body as { tokens: string[] }).tokens);
      expect(sent).toContain(CAIO_TOKEN_2);
    });
    // O resolve leva só os tokens (sem RSSI, sem nada além).
    for (const call of api.callsTo('POST /v1/proximity/resolve')) {
      expect(Object.keys(call.body as object)).toEqual(['tokens']);
    }

    await userEvent.press(screen.getByRole('button', { name: 'Conectar com @caio.r' }));
    expect(
      await screen.findByRole('header', { name: 'Aguardando Caio confirmar' }),
    ).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')[0]?.body).toEqual({
      targetToken: CAIO_TOKEN_2,
      method: 'ble',
    });
    // Aguardando: continua anunciando (B vê o token novo de A) e a tela fica acesa.
    expect(radio.advertising).not.toBeNull();
    expect(radio.keepScreenOn).toBe(true);

    expect(
      await screen.findByRole('header', { name: 'Você e Caio estão conectados' }),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Conectados pessoalmente em \d+ \w{3} \d{4}\./)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.goHome })).toBeOnTheScreen();
    // Conectados: anúncio e varredura param.
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    expect(radio.advertising).toBeNull();
    expect(radio.keepScreenOn).toBe(false);

    await userEvent.press(screen.getByRole('button', { name: COPY.connectAnother }));
    expect(await screen.findByText(COPY.intro)).toBeOnTheScreen();
  });

  it('4.4 CA4: quem já é conexão aparece com "Conectados" no lugar do botão', async () => {
    const radio = createFakeRadio();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/resolve', {
          status: 200,
          body: { items: [nearbyPerson({ alreadyConnected: true })] },
        });
      },
    });
    await startSearching();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await act(async () => {
      radio.emitSighting(CAIO_TOKEN, -55);
      await Promise.resolve();
    });
    const row = await screen.findByTestId('por-perto-caio.r');
    expect(within(row).getByText(COPY.connectedLabel)).toBeOnTheScreen();
    expect(within(row).queryByRole('button', { name: 'Conectar com @caio.r' })).toBeNull();
  });

  it('4.4 CA6: 20 s sem ninguém → "Ninguém por perto ainda" com o QR; a varredura continua', async () => {
    connectTiming.nobodyAfterMs = 60;
    const radio = createFakeRadio();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureNearby,
    });
    await startSearching();
    expect(await screen.findByRole('header', { name: COPY.nobodyTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.nobodyText)).toBeOnTheScreen();
    expect(radio.scanning).toBe(true);
    await userEvent.press(screen.getByRole('button', { name: COPY.useQr }));
    expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'QR code' })).toBeChecked();
    // Fora da busca, a varredura para.
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
  });

  it('4.5 CA4: já conectados (409) → Toast "Vocês já estão conectados."', async () => {
    const radio = createFakeRadio();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureNearby(fake);
        fake.on('POST /v1/connections/requests', apiError(409, 'ALREADY_CONNECTED'));
      },
    });
    await startSearching();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await act(async () => {
      radio.emitSighting(CAIO_TOKEN, -60);
      await Promise.resolve();
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Conectar com @caio.r' }));
    expect(await screen.findByText(COPY.alreadyConnected)).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('por-perto-caio.r')).getByText(COPY.connectedLabel),
    ).toBeTruthy();
  });

  it('PROX-25: a pessoa parou de anunciar → a linha some com "Caio saiu de perto. Procure de novo."', async () => {
    connectTiming.goneAfterMs = 40;
    const radio = createFakeRadio();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureNearby,
    });
    await startSearching();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await act(async () => {
      radio.emitSighting(CAIO_TOKEN, -60);
      await Promise.resolve();
    });
    const button = await screen.findByRole('button', { name: 'Conectar com @caio.r' });
    // O renderRouter usa relógio falso: avança o tempo sem novos anúncios de Caio.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(80);
    });
    await userEvent.press(button);
    expect(await screen.findByText(COPY.left('Caio'))).toBeOnTheScreen();
    await waitFor(() => {
      expect(screen.queryByTestId('por-perto-caio.r')).not.toBeOnTheScreen();
    });
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });

  it('4.6 CA8 / §5.2: token recusado com a pessoa ainda por perto → a mensagem genérica (a recusa nunca aparece)', async () => {
    const radio = createFakeRadio();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureNearby(fake);
        fake.on('POST /v1/connections/requests', apiError(400, 'PROXIMITY_TOKEN_INVALID'));
      },
    });
    await startSearching();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await act(async () => {
      radio.emitSighting(CAIO_TOKEN, -60);
      await Promise.resolve();
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Conectar com @caio.r' }));
    expect(await screen.findByText(COPY.cannotSend)).toBeOnTheScreen();
    expect(screen.getByTestId('por-perto-caio.r')).toBeOnTheScreen();
  });

  it('4.5 CA9: "Cancelar pedido" cancela e volta ao Inicial', async () => {
    const radio = createFakeRadio();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureNearby(fake);
        fake.on('POST /v1/connections/requests', { status: 201, body: REQUEST });
        fake.on(`GET /v1/connections/requests/${REQUEST.id}`, { status: 200, body: REQUEST });
        fake.on(`DELETE /v1/connections/requests/${REQUEST.id}`, {
          status: 200,
          body: connectionRequest({ status: 'not_confirmed', expiresInS: 0 }),
        });
      },
    });
    await startSearching();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await act(async () => {
      radio.emitSighting(CAIO_TOKEN, -60);
      await Promise.resolve();
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Conectar com @caio.r' }));
    await userEvent.press(await screen.findByRole('button', { name: COPY.cancelRequest }));
    expect(await screen.findByText(COPY.intro)).toBeOnTheScreen();
    expect(api.callsTo(`DELETE /v1/connections/requests/${REQUEST.id}`)).toHaveLength(1);
    await waitFor(() => {
      expect(radio.advertising).toBeNull();
    });
  });

  it('4.5 CA8: o pedido venceu → "Caio não confirmou" com "Tentar de novo" (de volta à busca)', async () => {
    const radio = createFakeRadio();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureNearby(fake);
        fake.on('POST /v1/connections/requests', { status: 201, body: REQUEST });
        fake.on(`GET /v1/connections/requests/${REQUEST.id}`, {
          status: 200,
          body: connectionRequest({ status: 'not_confirmed', expiresInS: 0 }),
        });
      },
    });
    await startSearching();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await act(async () => {
      radio.emitSighting(CAIO_TOKEN, -60);
      await Promise.resolve();
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Conectar com @caio.r' }));
    expect(await screen.findByRole('header', { name: 'Caio não confirmou' })).toBeOnTheScreen();
    expect(screen.getByText(COPY.notConfirmedText)).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.tryAgain }));
    expect(await screen.findByText(COPY.searching)).toBeOnTheScreen();
  });

  it('4.5 CA7: 429 no pedido → "Muitas tentativas"', async () => {
    const radio = createFakeRadio();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureNearby(fake);
        fake.on('POST /v1/connections/requests', apiError(429, 'RATE_LIMITED'));
      },
    });
    await startSearching();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await act(async () => {
      radio.emitSighting(CAIO_TOKEN, -60);
      await Promise.resolve();
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Conectar com @caio.r' }));
    expect(await screen.findByRole('header', { name: COPY.pausedTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.pausedText)).toBeOnTheScreen();
    // Pausado: nada de anúncio nem varredura.
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    expect(radio.advertising).toBeNull();
  });
});

describe('Conectar: estados de erro e de Bluetooth (ux.md §4.12 e §5.2)', () => {
  it('4.2 CA5: Redis fora (503) → "Conectar está indisponível agora"; "Tentar de novo" volta', async () => {
    let down = true;
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/tokens', () =>
          down
            ? apiError(503, 'PROXIMITY_UNAVAILABLE')
            : {
                status: 201,
                body: {
                  token: MY_TOKENS[0],
                  expiresAt: '2026-10-30T12:00:30.000Z',
                  renewInS: 20,
                },
              },
        );
      },
    });
    expect(await screen.findByRole('header', { name: COPY.unavailableTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.unavailableText)).toBeOnTheScreen();
    down = false;
    await userEvent.press(screen.getByRole('button', { name: COPY.tryAgain }));
    expect(await screen.findByText(COPY.intro)).toBeOnTheScreen();
  });

  it('X.3: e-mail não confirmado → aviso com "Verificar e-mail", sem pedir token', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe({ emailVerified: false }),
      initialUrl: '/pessoal/conectar',
      configure: configureConnect,
    });
    expect(await screen.findByRole('header', { name: COPY.emailTitle })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.verifyEmail })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(0);
  });

  it('4.3 CA4: permissão ainda não pedida → explicação antes do pedido do sistema; permitido → procura', async () => {
    const radio = createFakeRadio({ permission: 'undetermined' });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureNearby,
    });
    await startSearching();
    expect(await screen.findByRole('header', { name: COPY.btExplainTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.btExplainText)).toBeOnTheScreen();
    // O pedido do sistema só sai no "Continuar".
    expect(radio.permissionRequests).toBe(0);
    await userEvent.press(screen.getByRole('button', { name: COPY.continue }));
    expect(radio.permissionRequests).toBe(1);
    expect(await screen.findByText(COPY.searching)).toBeOnTheScreen();
  });

  it('MAN-BLE-03: permissão negada → "Bluetooth sem permissão" com "Abrir Ajustes" e "Usar QR code"', async () => {
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const radio = createFakeRadio({ permission: 'undetermined' });
    radio.permissionAnswer = 'denied';
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureNearby,
    });
    await startSearching();
    await userEvent.press(await screen.findByRole('button', { name: COPY.continue }));
    expect(await screen.findByRole('header', { name: COPY.btDeniedTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.btDeniedText)).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.openSettings }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    await userEvent.press(screen.getByRole('button', { name: COPY.useQr }));
    expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
    expect(radio.scanning).toBe(false);
  });

  it('MAN-BLE-03: Bluetooth desligado → aviso; ao ligar, a busca começa sozinha', async () => {
    const radio = createFakeRadio({ bluetooth: 'off' });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureNearby,
    });
    await startSearching();
    expect(await screen.findByRole('header', { name: COPY.btOffTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.btOffText)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.useQr })).toBeOnTheScreen();
    await act(async () => {
      radio.emitState('on');
      await Promise.resolve();
    });
    expect(await screen.findByText(COPY.searching)).toBeOnTheScreen();
  });

  it('4.1 CA4 / 4.3 CA4: aparelho que não anuncia → aviso com QR; "Procurar mesmo assim" só varre', async () => {
    const radio = createFakeRadio({ canAdvertise: false });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureNearby,
    });
    await startSearching();
    expect(
      await screen.findByRole('header', { name: COPY.cannotAdvertiseTitle }),
    ).toBeOnTheScreen();
    expect(screen.getByText(COPY.cannotAdvertiseText)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.useQr })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.searchAnyway }));
    expect(await screen.findByText(COPY.searching)).toBeOnTheScreen();
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    expect(radio.advertising).toBeNull();
  });

  it('sem o módulo nativo (Expo Go ou dev build antigo) → "Bluetooth indisponível" com o QR', async () => {
    const radio = createFakeRadio({
      available: false,
      bleSupported: false,
      bluetooth: 'unsupported',
    });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureNearby,
    });
    await startSearching();
    expect(await screen.findByRole('header', { name: COPY.btUnavailableTitle })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.useQr }));
    expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
  });

  it('4.3 CA3 / PROX-28: em background o anúncio e a varredura param; ao voltar recomeçam', async () => {
    const setAppState = captureAppState();
    const radio = createFakeRadio();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureNearby,
    });
    await startSearching();
    await waitFor(() => {
      expect(radio.advertising).toBe(MY_TOKENS[0]);
    });
    expect(radio.scanning).toBe(true);

    await setAppState('background');
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    expect(radio.advertising).toBeNull();
    expect(radio.keepScreenOn).toBe(false);
    const tokensBefore = api.callsTo('POST /v1/proximity/tokens').length;
    // Em background, nem token novo nem polling.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(tokensBefore);

    await setAppState('active');
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    // Volta com um token novo no anúncio, ainda procurando.
    await waitFor(() => {
      expect(radio.advertising).toBe(MY_TOKENS[1]);
    });
    expect(screen.getByText(COPY.searching)).toBeOnTheScreen();
  });

  it('PROX-28: sair da aba para o anúncio e a varredura; a volta começa no Inicial', async () => {
    const radio = createFakeRadio();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      radio,
      configure: configureNearby,
    });
    await startSearching();
    await waitFor(() => {
      expect(radio.advertising).not.toBeNull();
    });
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    expect(radio.advertising).toBeNull();
    expect(radio.keepScreenOn).toBe(false);
    await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
    expect(await screen.findByText(COPY.intro)).toBeOnTheScreen();
  });
});
