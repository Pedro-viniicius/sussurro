import { proximityQrPayload } from '@sussurro/shared';
import { qrMatrix } from '@sussurro/ui';
import { fireEvent, userEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';
import { Linking } from 'react-native';

import { COPY } from './copy';
import { savePendingQrToken, takePendingQrToken } from './pending-qr-link';
import { connectTiming } from './timing';
import { cameraMock } from '../../test-utils/camera-mock';
import {
  apiError,
  BIA_TOKEN,
  CAIO_TOKEN,
  configureConnect,
  connectionRequest,
  HELENA_TOKEN,
  incomingRequest,
  MY_TOKENS,
  nearbyPerson,
} from '../../test-utils/connect-fixtures';
import { creatorMe, type FakeApi, type FakeCall, personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';

const SAVED_TIMING = { ...connectTiming };
const QR_REQUEST = connectionRequest({ method: 'qr' });
const HELENA_QR_REQUEST = incomingRequest({ method: 'qr' });

const PEOPLE = {
  [CAIO_TOKEN]: nearbyPerson(),
  [BIA_TOKEN]: nearbyPerson({ token: BIA_TOKEN, handle: 'bia.alves', name: 'Bianca Alves' }),
  [HELENA_TOKEN]: nearbyPerson({ token: HELENA_TOKEN, handle: 'helena', name: 'Helena Souza' }),
} as const;

function resolver({ body }: FakeCall) {
  const tokens = (body as { tokens: string[] }).tokens;
  const items = tokens.flatMap((token) => {
    const person = (PEOPLE as Record<string, (typeof PEOPLE)[keyof typeof PEOPLE] | undefined>)[
      token
    ];
    return person === undefined ? [] : [person];
  });
  return { status: 200, body: { items } };
}

function configureQr(api: FakeApi) {
  configureConnect(api);
  api.on('POST /v1/proximity/resolve', resolver);
  api.on('POST /v1/connections/requests', { status: 201, body: QR_REQUEST });
  api.on(`GET /v1/connections/requests/${QR_REQUEST.id}`, { status: 200, body: QR_REQUEST });
}

/** A câmera "lê" um QR. */
async function scan(data: string) {
  const camera = await screen.findByTestId('qr-camera');
  await fireEvent(camera, 'barcodeScanned', { data });
}

function qrPathOf(testID: string): unknown {
  const svg = screen.getByTestId(testID);
  return svg.queryAll((node) => typeof node.props.d === 'string')[0]?.props.d;
}

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, resolveMinIntervalMs: 0, tickMs: 20 });
  cameraMock.reset();
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('Conectar por QR code (4.7, D3 e D7)', () => {
  it('4.7 CA1: a aba "QR code" mostra meu código (sussurro://c/{token}) com o @, renovado sem piscar', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    await userEvent.press(await screen.findByRole('radio', { name: 'QR code' }));
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

  it('4.7 CA2 + D7: A lê o QR de B → pedido com method "qr"; o "Aguardando" mostra o QR de A', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    await userEvent.press(await screen.findByRole('radio', { name: 'QR code' }));
    await userEvent.press(screen.getByRole('button', { name: COPY.readTheirCode }));
    await scan(proximityQrPayload(CAIO_TOKEN));

    expect(
      await screen.findByRole('header', { name: 'Aguardando Caio confirmar' }),
    ).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/proximity/resolve')[0]?.body).toEqual({ tokens: [CAIO_TOKEN] });
    expect(api.callsTo('POST /v1/connections/requests')[0]?.body).toEqual({
      targetToken: CAIO_TOKEN,
      method: 'qr',
    });
    // QR cruzado: Caio precisa ler o código de A para confirmar.
    expect(screen.getByText(COPY.waitingQr('Caio'))).toBeOnTheScreen();
    expect(screen.getByTestId('qr-card-qr')).toBeTruthy();
    expect(screen.queryByTestId('qr-scanner')).not.toBeOnTheScreen();
  });

  it('4.7 CA4: QR que não é do Sussurro ou vencido → mensagem amigável e nada é criado', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    await userEvent.press(await screen.findByRole('radio', { name: 'QR code' }));
    await userEvent.press(screen.getByRole('button', { name: COPY.readTheirCode }));

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

  it('MAN-QR-01 / 4.7 CA5: câmera negada → "Câmera sem permissão" com "Abrir Ajustes" e "Mostrar meu código"', async () => {
    cameraMock.set('denied', false);
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    await userEvent.press(await screen.findByRole('radio', { name: 'QR code' }));
    await userEvent.press(screen.getByRole('button', { name: COPY.readTheirCode }));
    expect(await screen.findByRole('header', { name: COPY.cameraDeniedTitle })).toBeOnTheScreen();
    expect(screen.getByText(COPY.cameraDeniedText)).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.openSettings }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    await userEvent.press(screen.getByRole('button', { name: COPY.showMyCode }));
    await waitFor(() => {
      expect(screen.queryByTestId('qr-scanner')).not.toBeOnTheScreen();
    });
    expect(screen.getByTestId('qr-card')).toBeOnTheScreen();
  });

  it('ux.md §4.12: câmera ainda não pedida → explicação e só então o pedido do sistema', async () => {
    cameraMock.set('undetermined');
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: configureQr,
    });
    await userEvent.press(await screen.findByRole('radio', { name: 'QR code' }));
    await userEvent.press(screen.getByRole('button', { name: COPY.readTheirCode }));
    expect(await screen.findByRole('header', { name: COPY.cameraExplainTitle })).toBeOnTheScreen();
    expect(cameraMock.requests).toBe(0);
    await userEvent.press(screen.getByRole('button', { name: COPY.continue }));
    expect(cameraMock.requests).toBe(1);
    expect(await screen.findByTestId('qr-camera')).toBeOnTheScreen();
  });

  it('PROX-24 / 4.7 CA3 (D7): B só aceita lendo o QR de A; o código de outra pessoa não aceita', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe({ handle: 'caio.r', name: 'Caio Ribeiro' }),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureQr(fake);
        let accepted = false;
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: accepted ? [] : [HELENA_QR_REQUEST] },
        }));
        fake.on(`POST /v1/connections/requests/${HELENA_QR_REQUEST.id}/accept`, () => {
          accepted = true;
          return {
            status: 200,
            body: { ...HELENA_QR_REQUEST, status: 'accepted', expiresInS: 0 },
          };
        });
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    // No QR, não há "Aceitar" direto: o aceite é a leitura do código de Helena.
    expect(screen.queryByRole('button', { name: COPY.accept })).toBeNull();
    await userEvent.press(screen.getByRole('button', { name: COPY.acceptByQr }));

    await scan(proximityQrPayload(BIA_TOKEN));
    expect(await screen.findByTestId('qr-erro')).toHaveTextContent(COPY.qrNotTheirs('Helena'));
    expect(
      api.callsTo(`POST /v1/connections/requests/${HELENA_QR_REQUEST.id}/accept`),
    ).toHaveLength(0);

    await scan(proximityQrPayload(HELENA_TOKEN));
    expect(
      await screen.findByRole('header', { name: 'Você e Helena estão conectados' }),
    ).toBeOnTheScreen();
    expect(
      api.callsTo(`POST /v1/connections/requests/${HELENA_QR_REQUEST.id}/accept`)[0]?.body,
    ).toEqual({ observedToken: HELENA_TOKEN });
  });
});

describe('deep link do QR (sussurro://c/{token}, 4.7 CA6)', () => {
  it('logada: abre Conectar e segue o fluxo QR (pedido com method "qr")', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/c/${CAIO_TOKEN}`,
      configure: configureQr,
    });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/conectar');
    });
    expect(
      await screen.findByRole('header', { name: 'Aguardando Caio confirmar' }),
    ).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(1);
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

  it('PROX-24: depois de entrar (em até 30 s), o fluxo QR continua na aba Conectar', async () => {
    savePendingQrToken(CAIO_TOKEN);
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: configureQr,
    });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/conectar');
    });
    expect(
      await screen.findByRole('header', { name: 'Aguardando Caio confirmar' }),
    ).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(1);
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
