import { proximityQrPayload } from '@sussurro/shared';
import { qrMatrix } from '@sussurro/ui';
import { fireEvent, userEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, Linking } from 'react-native';

import { COPY } from './copy';
import { savePendingQrToken, takePendingQrToken } from './pending-qr-link';
import { connectTiming } from './timing';
import { cameraMock } from '../../test-utils/camera-mock';
import {
  apiError,
  CAIO_TOKEN,
  configureConnect,
  connectionRequest,
  MY_TOKENS,
  nearbyPerson,
  resolver,
} from '../../test-utils/connect-fixtures';
import { creatorMe, type FakeApi, personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';

const SAVED_TIMING = { ...connectTiming };
const QR_REQUEST = connectionRequest({ method: 'qr' });

function configureQr(api: FakeApi) {
  configureConnect(api);
  api.on('POST /v1/connections/requests', { status: 201, body: QR_REQUEST });
  api.on(`GET /v1/connections/requests/${QR_REQUEST.id}`, { status: 200, body: QR_REQUEST });
}

/** A câmera "lê" um QR. */
async function scan(data: string) {
  const camera = await screen.findByTestId('qr-camera');
  await fireEvent(camera, 'barcodeScanned', { data });
}

/** "Ler código" → "Usar a câmera". */
async function openCamera() {
  await userEvent.press(await screen.findByRole('radio', { name: COPY.modeRead }));
  await userEvent.press(await screen.findByRole('button', { name: COPY.useCamera }));
}

function qrPathOf(testID: string): unknown {
  const svg = screen.getByTestId(testID);
  return svg.queryAll((node) => typeof node.props.d === 'string')[0]?.props.d;
}

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, tickMs: 20 });
  cameraMock.reset();
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('Conectar por QR code (4.7, D3 e D7; ADR 0013 §5)', () => {
  it('4.7 CA1 / ADR 0013 §1: "Mostrar meu código" é o padrão e mostra o meu token (sussurro://c/{token}), renovado sem piscar', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    expect(await screen.findByRole('radio', { name: COPY.modeShow })).toBeChecked();
    await waitFor(() => {
      expect(qrPathOf('qr-card-qr')).toBe(qrMatrix(proximityQrPayload(MY_TOKENS[0])).path);
    });
    expect(screen.getByText('helena')).toBeOnTheScreen();
    expect(screen.getByText(COPY.qrHint)).toBeOnTheScreen();

    // 20 s depois, o token novo vira o QR novo; nunca há quadro "carregando" no meio.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    await waitFor(() => {
      expect(qrPathOf('qr-card-qr')).toBe(qrMatrix(proximityQrPayload(MY_TOKENS[1])).path);
    });
    expect(screen.queryByTestId('qr-card-carregando')).not.toBeOnTheScreen();
  });

  it('4.7 CA2 + D7: A lê o QR de B pela câmera → cartão de Caio → "Conectar" → pedido com method "qr"; o "Aguardando" mostra o QR de A', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));

    // O cartão: nada é enviado antes do toque em "Conectar".
    expect(await screen.findByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    expect(screen.getByText(COPY.cardCheck)).toBeOnTheScreen();
    expect(screen.queryByTestId('qr-scanner')).not.toBeOnTheScreen();
    expect(api.callsTo('POST /v1/proximity/resolve')[0]?.body).toEqual({ tokens: [CAIO_TOKEN] });
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
    // Antes do pedido não há ‹Denunciar› nem ‹Bloquear› no cartão.
    expect(screen.queryByRole('button', { name: 'Denunciar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bloquear' })).toBeNull();

    await userEvent.press(
      screen.getByRole('button', { name: COPY.connectWithLabel('Caio Ribeiro', 'caio.r') }),
    );
    expect(
      await screen.findByRole('header', { name: 'Aguardando Caio confirmar' }),
    ).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')[0]?.body).toEqual({
      targetToken: CAIO_TOKEN,
      method: 'qr',
    });
    // Leitura cruzada: Caio precisa ler o código de A para confirmar.
    expect(screen.getByText(COPY.waitingQr('Caio'))).toBeOnTheScreen();
    expect(screen.getByTestId('qr-card-qr')).toBeTruthy();
  });

  it('4.7 CA4: QR que não é do Sussurro ou vencido → mensagem amigável e nada é criado', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    await openCamera();

    // Adulterado / de outro app: nem chega na API.
    await scan('https://example.com/c/AbCdEfGhIjKlMn-_');
    expect(await screen.findByTestId('qr-erro')).toHaveTextContent(COPY.qrInvalid);
    await scan('sussurro://c/curto');
    expect(api.callsTo('POST /v1/proximity/resolve')).toHaveLength(0);

    // Bem formado, mas vencido: o resolve não acha ninguém.
    await scan(proximityQrPayload('VencidoTokenGGG1'));
    await waitFor(() => {
      expect(api.callsTo('POST /v1/proximity/resolve')).toHaveLength(1);
    });
    expect(await screen.findByTestId('qr-erro')).toHaveTextContent(COPY.qrInvalid);
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });

  it('estado 12: o código de quem já é conexão → "Vocês já estão conectados." com Voltar, sem Conectar', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureQr(fake);
        fake.on(
          'POST /v1/proximity/resolve',
          resolver({ [CAIO_TOKEN]: nearbyPerson({ alreadyConnected: true }) }),
        );
      },
    });
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    expect(await screen.findByText(COPY.alreadyConnected)).toBeOnTheScreen();
    expect(screen.queryByTestId('cartao-principal')).toBeNull();
    await userEvent.press(screen.getByRole('button', { name: COPY.back }));
    expect(await screen.findByTestId('conectar-ler')).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });

  it('R8: 409 ALREADY_CONNECTED no "Conectar" → o cartão vira "Vocês já estão conectados."', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureQr(fake);
        fake.on('POST /v1/connections/requests', apiError(409, 'ALREADY_CONNECTED'));
      },
    });
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    await userEvent.press(await screen.findByTestId('cartao-principal'));
    expect(await screen.findByText(COPY.alreadyConnected)).toBeOnTheScreen();
  });

  it('o código venceu antes do "Conectar" (400) → volta à leitura com o aviso, e nada fica pendente', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureQr(fake);
        fake.on('POST /v1/connections/requests', apiError(400, 'PROXIMITY_TOKEN_INVALID'));
      },
    });
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    await userEvent.press(await screen.findByTestId('cartao-principal'));
    expect(await screen.findByText(COPY.cardExpired('Caio'))).toBeOnTheScreen();
    expect(await screen.findByTestId('conectar-ler')).toBeOnTheScreen();
  });

  it('NFC-20 (S1): o Toast do código vencido é anunciado em fila depois do foco no início, sem ser cortado', async () => {
    const queued = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
    const immediate = jest.mocked(AccessibilityInfo.announceForAccessibility);
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureQr(fake);
        fake.on('POST /v1/connections/requests', apiError(400, 'PROXIMITY_TOKEN_INVALID'));
      },
    });
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    const connect = await screen.findByTestId('cartao-principal');
    queued.mockClear();
    immediate.mockClear();
    await userEvent.press(connect);
    await screen.findByText(COPY.cardExpired('Caio'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(
        connectTiming.focusDelayMs + connectTiming.announceAfterFocusMs,
      );
    });
    expect(queued).toHaveBeenCalledWith(COPY.cardExpired('Caio'), { queue: true });
    expect(immediate).not.toHaveBeenCalledWith(COPY.cardExpired('Caio'));
  });

  it('MAN-QR-01 / 4.7 CA5: câmera negada → "Câmera sem permissão" com "Abrir Ajustes" e "Mostrar meu código"', async () => {
    cameraMock.set('denied', false);
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    await openCamera();
    expect(await screen.findByRole('header', { name: COPY.cameraDeniedTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.cameraDeniedText)).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.openSettings }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    await userEvent.press(screen.getByRole('button', { name: COPY.showMyCode }));
    await waitFor(() => {
      expect(screen.queryByTestId('qr-scanner')).not.toBeOnTheScreen();
    });
    expect(screen.getByTestId('qr-card')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: COPY.modeShow })).toBeChecked();
  });

  it('ux.md §4.12: câmera ainda não pedida → explicação e só então o pedido do sistema', async () => {
    cameraMock.set('undetermined');
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    await openCamera();
    expect(await screen.findByRole('header', { name: COPY.cameraExplainTitle })).toBeOnTheScreen();
    expect(cameraMock.requests).toBe(0);
    await userEvent.press(screen.getByRole('button', { name: COPY.continue }));
    expect(cameraMock.requests).toBe(1);
    expect(await screen.findByTestId('qr-camera')).toBeOnTheScreen();
  });
});

describe('deep link do código (sussurro://c/{token}, 4.7 CA6)', () => {
  it('logada: abre Conectar no cartão da pessoa; nada é enviado sem o toque em "Conectar" (pedido com method "qr")', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/c/${CAIO_TOKEN}`,
      configure: configureQr,
    });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/conectar');
    });
    expect(await screen.findByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
    expect(api.calls.some((call) => call.key.endsWith('/accept'))).toBe(false);

    await userEvent.press(screen.getByTestId('cartao-principal'));
    expect(
      await screen.findByRole('header', { name: 'Aguardando Caio confirmar' }),
    ).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')[0]?.body).toEqual({
      targetToken: CAIO_TOKEN,
      method: 'qr',
    });
  });

  it('logada, com um token adulterado: mensagem amigável e nada é enviado', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/c/curto',
      configure: configureQr,
    });
    expect(await screen.findByText(COPY.qrInvalid)).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/proximity/resolve')).toHaveLength(0);
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });

  it('PROX-24: sem sessão, guarda o token e pede para entrar', async () => {
    await renderApp({ initialUrl: `/c/${CAIO_TOKEN}` });
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(takePendingQrToken()).toBe(CAIO_TOKEN);
  });

  it('PROX-24: depois de entrar (em até 30 s), o cartão aparece na aba Conectar', async () => {
    savePendingQrToken(CAIO_TOKEN);
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: configureQr,
    });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/conectar');
    });
    expect(await screen.findByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });

  it('o token guardado há mais de 30 s é descartado: a pessoa fica no Início', async () => {
    savePendingQrToken(CAIO_TOKEN, Date.now() - connectTiming.pendingLinkTtlMs - 1);
    const { api } = await renderApp({ signedInAs: personalMe(), configure: configureQr });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
  });
});

describe('Conectar bloqueado para criador (4.8)', () => {
  it.each([`/c/${CAIO_TOKEN}`, '/pessoal/conectar'])(
    '4.8 CA2: o criador que abre %s vê o p22 com "Voltar ao perfil"',
    async (url) => {
      const { api } = await renderApp({ signedInAs: creatorMe(), initialUrl: url });
      expect(await screen.findByRole('header', { name: COPY.creatorTitle })).toBeOnTheScreen();
      expect(screen.getByText(COPY.creatorText)).toBeOnTheScreen();
      expect(screen).toHavePathname('/criador/conectar');
      expect(api.callsTo('POST /v1/proximity/tokens')).toHaveLength(0);
      await userEvent.press(screen.getByRole('button', { name: COPY.backToProfile }));
      await waitFor(() => {
        expect(screen).toHavePathname('/criador/perfil');
      });
    },
  );

  it('4.8: o 403 do servidor para o criador mostra "indisponível" (nunca deveria chegar aqui)', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/tokens', apiError(403, 'ACCOUNT_TYPE_NOT_ALLOWED'));
      },
    });
    expect(await screen.findByRole('header', { name: COPY.unavailableTitle })).toBeOnTheScreen();
  });
});
