import { ErrorCode, type Me, proximityQrPayload } from '@sussurro/shared';
import { qrMatrix } from '@sussurro/ui';
import { fireEvent, userEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';
import {
  AccessibilityInfo,
  Alert,
  type AlertButton,
  AppState,
  type AppStateStatus,
  Linking,
} from 'react-native';

import { COPY } from './copy';
import { savePendingQrToken, takePendingQrToken } from './pending-qr-link';
import { connectTiming } from './timing';
import { errorMessage } from '../../lib/error-messages';
import { cameraMock } from '../../test-utils/camera-mock';
import {
  apiError,
  CAIO_TOKEN,
  configureConnect,
  connectionRequest,
  MY_TOKENS,
  nearbyPerson,
  proximityToken,
  resolver,
} from '../../test-utils/connect-fixtures';
import {
  creatorMe,
  type FakeApi,
  type FakeReply,
  personalMe,
  session,
} from '../../test-utils/fake-api';
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

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** Captura os ouvintes do AppState para o teste mandar o app ao segundo plano e de volta. */
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

  it('PROX-68 (C4): o "Tentar de novo" da parada (20) começa sem o código de antes — em "Mostrar meu código", o QR fica no carregando até a nova emissão, com o T33 na tela; depois, o código novo', async () => {
    let holdTokens = false;
    let release: () => void = () => undefined;
    let issued = 0;
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureQr(fake);
        fake.on('POST /v1/proximity/resolve', apiError(429, 'RATE_LIMITED'));
        fake.on('POST /v1/proximity/tokens', () => {
          const reply: FakeReply = { status: 201, body: proximityToken(issued) };
          issued += 1;
          if (!holdTokens) return reply;
          return new Promise<FakeReply>((resolve) => {
            release = () => {
              resolve(reply);
            };
          });
        });
      },
    });
    await waitFor(() => {
      expect(qrPathOf('qr-card-qr')).toBe(qrMatrix(proximityQrPayload(MY_TOKENS[0])).path);
    });
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    expect(await screen.findByRole('header', { name: COPY.pausedTitle })).toBeOnTheScreen();

    holdTokens = true;
    await userEvent.press(screen.getByRole('button', { name: COPY.tryAgain }));
    await userEvent.press(await screen.findByRole('radio', { name: COPY.modeShow }));
    expect(await screen.findByTestId('qr-card-carregando')).toBeOnTheScreen();
    await advance(1000);
    expect(screen.getByTestId('qr-card-carregando')).toBeOnTheScreen();
    expect(screen.queryByTestId('qr-card-qr')).toBeNull();
    expect(screen.getByText(COPY.qrHint)).toBeOnTheScreen();

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(qrPathOf('qr-card-qr')).toBe(qrMatrix(proximityQrPayload(MY_TOKENS[1])).path);
    });
    expect(screen.queryByTestId('qr-card-carregando')).not.toBeOnTheScreen();
  });

  it('PROX-68 (C4): na volta do segundo plano (sem parada), o QR continua com o código de antes até a nova emissão, sem o carregando', async () => {
    const setAppState = captureAppState();
    let holdTokens = false;
    let release: () => void = () => undefined;
    let issued = 0;
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureQr(fake);
        fake.on('POST /v1/proximity/tokens', () => {
          const reply: FakeReply = { status: 201, body: proximityToken(issued) };
          issued += 1;
          if (!holdTokens) return reply;
          return new Promise<FakeReply>((resolve) => {
            release = () => {
              resolve(reply);
            };
          });
        });
      },
    });
    await waitFor(() => {
      expect(qrPathOf('qr-card-qr')).toBe(qrMatrix(proximityQrPayload(MY_TOKENS[0])).path);
    });
    holdTokens = true;
    await setAppState('background');
    await advance(5000);
    await setAppState('active');
    await advance(1000);
    // A emissão da volta ainda não respondeu: o código de antes (válido por 30 s) continua.
    expect(screen.queryByTestId('qr-card-carregando')).toBeNull();
    expect(qrPathOf('qr-card-qr')).toBe(qrMatrix(proximityQrPayload(MY_TOKENS[0])).path);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(qrPathOf('qr-card-qr')).toBe(qrMatrix(proximityQrPayload(MY_TOKENS[1])).path);
    });
  });

  it('PROX-68 (teto; C3): o 409 de "tela fechada" na leitura pela câmera, com a janela cheia, espera a vaga; o app vai para o segundo plano, a espera é cancelada em silêncio (sem erro, sem Toast) e nenhuma emissão sai depois', async () => {
    const setAppState = captureAppState();
    let resolves = 0;
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureQr(fake);
        const resolve = resolver();
        fake.on('POST /v1/proximity/resolve', (call) => {
          resolves += 1;
          return resolves === 1 ? apiError(409, 'PROXIMITY_SCREEN_CLOSED') : resolve(call);
        });
      },
    });
    const tokenCalls = () => api.callsTo('POST /v1/proximity/tokens').length;
    await waitFor(() => {
      expect(tokenCalls()).toBe(1);
    });
    // Mais cinco visitas no mesmo minuto (Perfil e de volta): a janela de 60 s fica cheia (6).
    for (let visit = 2; visit <= 6; visit++) {
      await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
      expect(await screen.findByRole('header', { name: 'helena' })).toBeOnTheScreen();
      await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
      await waitFor(() => {
        expect(tokenCalls()).toBe(visit);
      });
    }
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    await advance(1000);
    // O resolve deu 409, e a renovação do token espera a vaga (nenhum 7º pedido).
    expect(resolves).toBe(1);
    expect(tokenCalls()).toBe(6);

    await setAppState('background');
    await advance(1000);
    await setAppState('active');
    await advance(1000);
    // A espera foi cancelada: a tela não para (o 19 seria o motivo errado) e nada de "Algo deu
    // errado", nem na leitura nem num Toast.
    expect(screen.queryByRole('header', { name: COPY.unavailableTitle })).toBeNull();
    expect(screen.queryByRole('header', { name: COPY.pausedTitle })).toBeNull();
    expect(screen.queryByRole('header', { name: COPY.offlineTitle })).toBeNull();
    expect(screen.queryByText(errorMessage(ErrorCode.INTERNAL_ERROR))).toBeNull();
    expect(screen.queryByTestId('qr-erro')).toBeNull();
    expect(resolves).toBe(1);
    expect(tokenCalls()).toBe(6);
    expect(api.callsTo('POST /v1/connections/requests')).toHaveLength(0);
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

describe('Conectar: o token depois de sair da tela e no fim da sessão (PROX-68; MÉDIO do seguranca)', () => {
  const HELENA = personalMe();
  const MARINA = personalMe({
    id: '01a189e0-af57-7000-85fe-2054e618feb1',
    email: 'marina@example.com',
    handle: 'marina',
    name: 'Marina Costa',
  });
  const tokenCalls = (api: FakeApi) => api.callsTo('POST /v1/proximity/tokens').length;
  const requestCalls = (api: FakeApi) => api.callsTo('POST /v1/connections/requests').length;

  beforeEach(() => {
    // Confirma o "Sair da conta?" (o botão destrutivo).
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
  });

  /** Entra com `user` em Entrar (a API falsa devolve a sessão dele) e espera o Início. */
  async function signInAs(api: FakeApi, user: Me) {
    api.on('POST /v1/auth/login', () => ({ status: 200, body: session(user) }));
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    await fireEvent.changeText(screen.getByLabelText('E-mail'), user.email);
    await fireEvent.changeText(screen.getByLabelText('Senha'), 'cafe-coado-42');
    await userEvent.press(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByTestId('tela-inicio')).toBeOnTheScreen();
  }

  /** Sai do Conectar pela aba Perfil (a tela desmonta). */
  async function goToProfile() {
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    expect(await screen.findByRole('header', { name: HELENA.handle })).toBeOnTheScreen();
  }

  /** Helena lê o QR de Caio, toca em "Conectar", e o pedido fica em voo até `answer`; sai da aba. */
  async function connectByQrInFlight() {
    let answer: (reply: FakeReply) => void = () => undefined;
    const rendered = await renderApp({
      signedInAs: HELENA,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        fake.on(
          'POST /v1/connections/requests',
          () =>
            new Promise<FakeReply>((resolve) => {
              answer = resolve;
            }),
        );
        fake.on('POST /v1/auth/logout', { status: 204 });
      },
    });
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    await userEvent.press(
      await screen.findByRole('button', { name: COPY.connectWithLabel('Caio Ribeiro', 'caio.r') }),
    );
    await waitFor(() => {
      expect(requestCalls(rendered.api)).toBe(1);
    });
    await goToProfile();
    return {
      api: rendered.api,
      answer: (reply: FakeReply) => {
        answer(reply);
      },
    };
  }

  it('PROX-68: o 409 do pedido por QR que chega depois de sair da aba não emite token nem repete o pedido, e nada aparece', async () => {
    const { api, answer } = await connectByQrInFlight();
    const tokensBefore = tokenCalls(api);
    await act(async () => {
      answer(apiError(409, 'PROXIMITY_SCREEN_CLOSED'));
      await Promise.resolve();
    });
    await advance(60_000);
    expect(tokenCalls(api)).toBe(tokensBefore);
    expect(requestCalls(api)).toBe(1);
    expect(screen.getByRole('header', { name: HELENA.handle })).toBeOnTheScreen();
  });

  it('PROX-68: sai da aba, sai da conta e Marina entra; o 409 do pedido de Helena chega depois → nada sai com a sessão de Marina (nem a emissão, nem o pedido repetido)', async () => {
    const { api, answer } = await connectByQrInFlight();
    await userEvent.press(screen.getByRole('button', { name: 'Sair da conta' }));
    await signInAs(api, MARINA);
    const callsBefore = api.calls.length;
    await act(async () => {
      answer(apiError(409, 'PROXIMITY_SCREEN_CLOSED'));
      await Promise.resolve();
    });
    await advance(60_000);
    // Depois da troca, nenhuma emissão nem pedido de conexão (Marina nem abriu o Conectar).
    const after = api.calls.slice(callsBefore).map((call) => call.key);
    expect(after.filter((key) => key.startsWith('POST /v1/proximity/'))).toEqual([]);
    expect(after.filter((key) => key === 'POST /v1/connections/requests')).toEqual([]);
    expect(requestCalls(api)).toBe(1);
  });

  it('PROX-68 (BAIXO do seguranca): a renovação em voo, o app vai para o segundo plano e o 409 do pedido por QR chega → o pedido não é repetido com a tela inativa, nem quando a emissão em voo responde', async () => {
    const setAppState = captureAppState();
    let answer: (reply: FakeReply) => void = () => undefined;
    let releaseToken: () => void = () => undefined;
    let issued = 0;
    const { api } = await renderApp({
      signedInAs: HELENA,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        // 1º pedido certo; a renovação dos 20 s fica em voo até o `releaseToken`.
        fake.on('POST /v1/proximity/tokens', () => {
          const reply: FakeReply = { status: 201, body: proximityToken(issued) };
          issued += 1;
          if (issued === 1) return reply;
          return new Promise<FakeReply>((resolve) => {
            releaseToken = () => {
              resolve(reply);
            };
          });
        });
        fake.on(
          'POST /v1/connections/requests',
          () =>
            new Promise<FakeReply>((resolve) => {
              answer = resolve;
            }),
        );
      },
    });
    await waitFor(() => {
      expect(tokenCalls(api)).toBe(1);
    });
    await openCamera();
    await scan(proximityQrPayload(CAIO_TOKEN));
    await userEvent.press(
      await screen.findByRole('button', { name: COPY.connectWithLabel('Caio Ribeiro', 'caio.r') }),
    );
    await waitFor(() => {
      expect(requestCalls(api)).toBe(1);
    });
    // A renovação sai e fica em voo; depois, o app vai para o segundo plano (a tela continua
    // montada, mas inativa).
    await advance(20_000);
    expect(tokenCalls(api)).toBe(2);
    await setAppState('background');
    await act(async () => {
      answer(apiError(409, 'PROXIMITY_SCREEN_CLOSED'));
      await Promise.resolve();
    });
    await act(async () => {
      releaseToken();
      await Promise.resolve();
    });
    await advance(60_000);
    expect(requestCalls(api)).toBe(1);
    expect(tokenCalls(api)).toBe(2);
  });

  it.each<{ when: string; next: Me }>([
    { when: 'entrou outra conta', next: MARINA },
    { when: 'entrou de novo a mesma conta', next: HELENA },
  ])(
    'PROX-68: sem sair, a 7ª visita no mesmo minuto espera a vaga (o QR no carregando, nenhum 7º pedido, nenhum 429); "Sair da conta" e $when → o 1º pedido sai na hora (o RootNavigator esquece a janela)',
    async ({ next }) => {
      const { api } = await renderApp({
        signedInAs: HELENA,
        initialUrl: '/pessoal/conectar',
        configure: (fake) => {
          configureConnect(fake);
          fake.on('POST /v1/auth/logout', { status: 204 });
        },
      });
      await waitFor(() => {
        expect(tokenCalls(api)).toBe(1);
      });
      const firstAt = Date.now();
      // Cinco visitas novas no mesmo minuto: cada uma pede um token ao abrir (6 emissões).
      for (let visit = 2; visit <= 6; visit++) {
        await goToProfile();
        await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
        await waitFor(() => {
          expect(tokenCalls(api)).toBe(visit);
        });
      }
      // A 7ª visita: a janela de 60 s está cheia, e o 1º pedido espera a vaga.
      await goToProfile();
      await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
      expect(await screen.findByTestId('conectar-mostrar')).toBeOnTheScreen();
      await advance(1000);
      expect(tokenCalls(api)).toBe(6);
      expect(screen.getByTestId('qr-card-carregando')).toBeOnTheScreen();
      expect(Date.now() - firstAt).toBeLessThan(connectTiming.tokenIssueWindowMs - 10_000);

      // Sai da conta e entra de novo: a janela da sessão anterior é esquecida.
      await goToProfile();
      await userEvent.press(screen.getByRole('button', { name: 'Sair da conta' }));
      await signInAs(api, next);
      await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
      await advance(0);
      await waitFor(() => {
        expect(tokenCalls(api)).toBe(7);
      });
      // Tudo antes de a emissão mais antiga sair da janela: sem a limpeza, o 7º pedido esperaria.
      expect(Date.now() - firstAt).toBeLessThan(connectTiming.tokenIssueWindowMs);
      expect(await screen.findByTestId('qr-card-qr')).toBeOnTheScreen();
    },
  );
});
