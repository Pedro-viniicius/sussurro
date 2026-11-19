import { proximityQrPayload } from '@sussurro/shared';
import { fireEvent, userEvent, within } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, Alert, Platform } from 'react-native';

import { COPY } from './copy';
import * as devTools from './dev-tools';
import * as haptics from './haptics';
import { connectTiming } from './timing';
import {
  createFakeNfc,
  type FakeNfc,
  IPHONE_NFC_CAPABILITIES,
} from '../../../modules/sussurro-proximity/src/fake-nfc';
import { cameraMock } from '../../test-utils/camera-mock';
import {
  apiError,
  BIA_TOKEN,
  configureConnect,
  HELENA_TOKEN,
  incomingRequest,
  LUCAS_TOKEN,
} from '../../test-utils/connect-fixtures';
import { type FakeApi, personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';
import { REPORT_SENT_MESSAGE } from '../moderation/ReportForm';
import { blockedMessage, blockTitle } from '../moderation/useBlockAccount';

const SAVED_TIMING = { ...connectTiming };
const HELENA_REQUEST = incomingRequest();
const TOMAS_REQUEST = incomingRequest({
  id: '01a189e0-af57-7000-85fe-2054e618fe03',
  other: { handle: 'tomas', name: 'Tomás Lima', avatarUrl: null },
});
const ME = personalMe({ handle: 'caio.r', name: 'Caio Ribeiro' });
const ACCEPT = `POST /v1/connections/requests/${HELENA_REQUEST.id}/accept`;

const queued = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
const focus = jest.mocked(AccessibilityInfo.sendAccessibilityEvent);

/** O `testID` de cada elemento que recebeu o foco (o `ref` é a instância do `View`). */
function focusedTestIds(): unknown[] {
  return focus.mock.calls.map(
    ([target]) => (target as unknown as { props?: { testID?: unknown } }).props?.testID,
  );
}

/**
 * O pedido de Helena pendente; o aceite só passa com o token de Helena (D7): outro token → 400
 * `PROXIMITY_TOKEN_INVALID`, como o servidor.
 */
function configureHelena(fake: FakeApi) {
  configureConnect(fake);
  let accepted = false;
  fake.on('GET /v1/connections/requests/incoming', () => ({
    status: 200,
    body: { items: accepted ? [] : [HELENA_REQUEST] },
  }));
  fake.on(ACCEPT, ({ body }) => {
    if ((body as { observedToken?: string }).observedToken !== HELENA_TOKEN) {
      return apiError(400, 'PROXIMITY_TOKEN_INVALID');
    }
    accepted = true;
    return { status: 200, body: { ...HELENA_REQUEST, status: 'accepted', expiresInS: 0 } };
  });
}

async function openHelena(nfc: FakeNfc = createFakeNfc()) {
  const rendered = await renderApp({
    signedInAs: ME,
    initialUrl: '/pessoal/conectar',
    nfc,
    configure: configureHelena,
  });
  await screen.findByRole('header', { name: 'Helena quer se conectar' });
  return rendered;
}

/** Outro celular encostado: o NFC lê o código. */
async function nfcRead(nfc: FakeNfc, token: string) {
  await act(async () => {
    nfc.simulateRead(proximityQrPayload(token));
    await Promise.resolve();
  });
}

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, tickMs: 20 });
  cameraMock.reset();
  jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
  queued.mockClear();
  focus.mockClear();
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('pedido recebido na folha (4.6, ux.md §4.11)', () => {
  it('4.6 CA1/CA10: com a tela aberta, a folha "Helena quer se conectar" aparece; uma por vez; vibra leve; o foco vai ao título e o anúncio sai depois, em fila', async () => {
    const vibrate = jest.spyOn(haptics, 'vibrate').mockImplementation(() => undefined);
    const { api } = await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        let declined = false;
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: declined ? [TOMAS_REQUEST] : [HELENA_REQUEST, TOMAS_REQUEST] },
        }));
        fake.on(`POST /v1/connections/requests/${HELENA_REQUEST.id}/decline`, () => {
          declined = true;
          return { status: 200, body: { ...HELENA_REQUEST, status: 'declined', expiresInS: 0 } };
        });
      },
    });

    expect(
      await screen.findByRole('header', { name: 'Helena quer se conectar' }),
    ).toBeOnTheScreen();
    expect(screen.getByText('@helena · Helena Souza')).toBeOnTheScreen();
    expect(screen.getByText('Confirme só se Helena estiver aí com você.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.accept })).toBeOnTheScreen();
    expect(screen.getByTestId('folha-pedido-prazo')).toHaveTextContent(/^Expira em [12]:\d\d$/);
    expect(vibrate).toHaveBeenCalledWith('incoming');
    // ux.md §11.8 e §11.13: o foco vai ao título da folha, e o A5 sai depois dele, em fila.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(
        connectTiming.focusDelayMs + connectTiming.announceAfterFocusMs,
      );
    });
    expect(focusedTestIds()).toEqual(['folha-pedido-titulo']);
    expect(queued).toHaveBeenCalledWith(COPY.announceIncoming('Helena'), { queue: true });
    const focusedAt = focus.mock.invocationCallOrder[0] ?? Infinity;
    const announcedAt = queued.mock.invocationCallOrder[0] ?? -Infinity;
    expect(focusedAt).toBeLessThan(announcedAt);
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalledWith(
      COPY.announceIncoming('Helena'),
    );
    // Uma folha por vez: Tomás espera a vez.
    expect(screen.queryByRole('header', { name: 'Tomás quer se conectar' })).toBeNull();

    focus.mockClear();
    await userEvent.press(screen.getByRole('button', { name: COPY.decline }));
    expect(await screen.findByRole('header', { name: 'Tomás quer se conectar' })).toBeOnTheScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(connectTiming.focusDelayMs);
    });
    // A folha seguinte também leva o foco ao título.
    expect(focusedTestIds()).toEqual(['folha-pedido-titulo']);
    expect(api.callsTo(`POST /v1/connections/requests/${HELENA_REQUEST.id}/decline`)).toHaveLength(
      1,
    );
  });

  it('NFC-04 / D7 (Android): "Aceitar" pede a leitura do código de Helena; a leitura liga o NFC, e o token lido vai como observedToken', async () => {
    const nfc = createFakeNfc();
    const { api } = await openHelena(nfc);
    // Antes do "Aceitar", nada é enviado nem lido.
    expect(nfc.reading).toBe(false);
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(api.callsTo(ACCEPT)).toHaveLength(0);
    expect(await screen.findByText(COPY.acceptRead('Helena'))).toBeOnTheScreen();
    // N24: o encosto na folha, com o aviso de que com iPhone só a câmera funciona.
    expect(screen.getByTestId('folha-pedido-nfc')).toHaveTextContent(COPY.acceptReadNfc('Helena'));
    expect(screen.queryByText(COPY.readNfcTitle)).toBeNull();
    expect(screen.getByRole('button', { name: COPY.useCamera })).toBeOnTheScreen();
    expect(nfc.reading).toBe(true);

    await nfcRead(nfc, HELENA_TOKEN);
    expect(
      await screen.findByRole('header', { name: 'Você e Helena estão conectados' }),
    ).toBeOnTheScreen();
    expect(api.callsTo(ACCEPT)[0]?.body).toEqual({ observedToken: HELENA_TOKEN });
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(COPY.codeRead);
    // Conectados: a leitura para.
    expect(nfc.reading).toBe(false);
  });

  it('NFC-05 / D7: o código lido de outra pessoa → "Este código não é de Helena ou já venceu…" e o pedido continua; o certo depois aceita', async () => {
    const nfc = createFakeNfc();
    const { api } = await openHelena(nfc);
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    await nfcRead(nfc, BIA_TOKEN);
    expect(await screen.findByTestId('folha-pedido-erro')).toHaveTextContent(
      COPY.notTheirCode('Helena'),
    );
    // S2 (ux.md §11.19): no iOS o erro da folha é anunciado (o VoiceOver ignora a região viva).
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      COPY.notTheirCode('Helena'),
    );
    expect(screen.getByTestId('folha-pedido')).toBeOnTheScreen();
    expect(api.callsTo(ACCEPT)).toHaveLength(1);
    // A leitura continua ligada para o código certo.
    expect(nfc.reading).toBe(true);
    await nfcRead(nfc, HELENA_TOKEN);
    expect(
      await screen.findByRole('header', { name: 'Você e Helena estão conectados' }),
    ).toBeOnTheScreen();
    expect(api.callsTo(ACCEPT)).toHaveLength(2);
  });

  it('PROX-24 / D7 (câmera): "Usar a câmera" no aceite; o código de outra pessoa mostra o aviso na câmera e não fecha; o de Helena aceita', async () => {
    const { api } = await openHelena();
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    await userEvent.press(await screen.findByRole('button', { name: COPY.useCamera }));
    expect(await screen.findByText(COPY.scannerHintAccept('Helena'))).toBeOnTheScreen();
    const camera = await screen.findByTestId('qr-camera');
    await fireEvent(camera, 'barcodeScanned', { data: proximityQrPayload(BIA_TOKEN) });
    expect(await screen.findByTestId('qr-erro')).toHaveTextContent(COPY.notTheirCode('Helena'));
    expect(api.callsTo(ACCEPT)[0]?.body).toEqual({ observedToken: BIA_TOKEN });

    await fireEvent(screen.getByTestId('qr-camera'), 'barcodeScanned', {
      data: proximityQrPayload(HELENA_TOKEN),
    });
    expect(
      await screen.findByRole('header', { name: 'Você e Helena estão conectados' }),
    ).toBeOnTheScreen();
    expect(api.callsTo(ACCEPT)[1]?.body).toEqual({ observedToken: HELENA_TOKEN });
    expect(screen.queryByTestId('qr-scanner')).not.toBeOnTheScreen();
  });

  it('NFC-06 (iPhone): no aceite, "Aproximar do outro celular" abre a folha do sistema; fechar sem ler é silencioso', async () => {
    const nfc = createFakeNfc(IPHONE_NFC_CAPABILITIES);
    const { api } = await openHelena(nfc);
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    // Sem leitura contínua no iPhone: só pelo botão.
    expect(nfc.reading).toBe(false);
    expect(screen.queryByTestId('folha-pedido-nfc')).toBeNull();
    await userEvent.press(await screen.findByRole('button', { name: COPY.nfcTap }));
    expect(nfc.readStarts).toBe(1);
    await act(async () => {
      nfc.simulateReadError('cancelled');
      await Promise.resolve();
    });
    expect(screen.queryByTestId('folha-pedido-erro')).toBeNull();
    await userEvent.press(screen.getByRole('button', { name: COPY.nfcTap }));
    await nfcRead(nfc, HELENA_TOKEN);
    expect(
      await screen.findByRole('header', { name: 'Você e Helena estão conectados' }),
    ).toBeOnTheScreen();
    expect(api.callsTo(ACCEPT)[0]?.body).toEqual({ observedToken: HELENA_TOKEN });
  });

  it('NFC-03 (folha) / NFC-22 (S4): no aceite com o NFC desligado, "Ligar NFC" diz que abre os ajustes', async () => {
    const nfc = createFakeNfc({ enabled: false });
    await openHelena(nfc);
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    // O "Ligar NFC" da folha (o do "Mostrar meu código" fica por baixo).
    const sheet = await screen.findByTestId('folha-pedido-leitura');
    const turnOn = within(sheet).getByRole('button', { name: COPY.turnOnNfc });
    expect(turnOn).toHaveProp('accessibilityHint', COPY.turnOnNfcHint);
    expect(screen.queryByTestId('folha-pedido-nfc')).toBeNull();
    await userEvent.press(turnOn);
    expect(nfc.settingsOpened).toBe(1);
  });

  it('NFC-24 (S7) / MAN-QR-01: câmera negada no aceite → só "Abrir Ajustes" e o ✕, sem "Mostrar meu código"', async () => {
    cameraMock.set('denied', false);
    await openHelena();
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    await userEvent.press(await screen.findByRole('button', { name: COPY.useCamera }));
    expect(await screen.findByRole('header', { name: COPY.cameraDeniedTitle })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.openSettings })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: COPY.close })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: COPY.showMyCode })).toBeNull();
    // O ✕ volta à folha, que continua pedindo a leitura.
    await userEvent.press(screen.getByRole('button', { name: COPY.close }));
    await waitFor(() => {
      expect(screen.queryByTestId('qr-scanner')).not.toBeOnTheScreen();
    });
    expect(screen.getByTestId('folha-pedido-leitura')).toBeOnTheScreen();
  });

  it('NFC-24 (S7/N28): câmera negada no aceite → "Para aceitar, permita a câmera… na tela de Helena", sem o texto de "Ler código" nem "Mostrar meu código"', async () => {
    cameraMock.set('denied', false);
    await openHelena();
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    await userEvent.press(await screen.findByRole('button', { name: COPY.useCamera }));
    const denied = await screen.findByTestId('camera-negada');
    expect(within(denied).getByText(COPY.cameraDeniedTextAccept('Helena'))).toBeOnTheScreen();
    expect(screen.queryByText(COPY.cameraDeniedText)).toBeNull();
    expect(screen.queryByRole('button', { name: COPY.showMyCode })).toBeNull();
  });

  it('NFC-24 (N28, fora do aceite): câmera negada em "Ler código" → o texto de sempre e "Mostrar meu código"', async () => {
    cameraMock.set('denied', false);
    await openHelena();
    // Recusa o pedido: a folha fecha e "Ler código" abre a câmera fora do aceite.
    await userEvent.press(screen.getByRole('button', { name: COPY.decline }));
    await waitFor(() => {
      expect(screen.queryByTestId('folha-pedido')).not.toBeOnTheScreen();
    });
    await userEvent.press(await screen.findByRole('radio', { name: COPY.modeRead }));
    await userEvent.press(await screen.findByRole('button', { name: COPY.useCamera }));
    const denied = await screen.findByTestId('camera-negada');
    expect(within(denied).getByText(COPY.cameraDeniedText)).toBeOnTheScreen();
    expect(screen.queryByText(COPY.cameraDeniedTextAccept('Helena'))).toBeNull();
    expect(screen.getByRole('button', { name: COPY.showMyCode })).toBeOnTheScreen();
  });

  it('NFC-21 (S2, iPhone): o erro da folha do aceite é anunciado com o announce (o VoiceOver ignora a região viva)', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const nfc = createFakeNfc(IPHONE_NFC_CAPABILITIES);
    await openHelena(nfc);
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    await userEvent.press(await screen.findByRole('button', { name: COPY.nfcTap }));
    jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
    await nfcRead(nfc, BIA_TOKEN);
    expect(await screen.findByTestId('folha-pedido-erro')).toHaveTextContent(
      COPY.notTheirCode('Helena'),
    );
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      COPY.notTheirCode('Helena'),
    );
    expect(
      jest
        .mocked(AccessibilityInfo.announceForAccessibility)
        .mock.calls.filter(([message]) => message === COPY.notTheirCode('Helena')),
    ).toHaveLength(1);
  });

  it('NFC-06 (Expo Go, sem o módulo): o aceite só pela câmera', async () => {
    const nfc = createFakeNfc({
      available: false,
      supported: false,
      enabled: false,
      canEmit: false,
      canRead: false,
    });
    await openHelena(nfc);
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(await screen.findByRole('button', { name: COPY.useCamera })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: COPY.nfcTap })).toBeNull();
    expect(screen.queryByTestId('folha-pedido-nfc')).toBeNull();
    expect(nfc.readStarts).toBe(0);
  });

  it('4.6 CA6: aceite de pedido vencido (410) → a folha fecha com "O pedido de Helena expirou."', async () => {
    await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        fake.on('GET /v1/connections/requests/incoming', {
          status: 200,
          body: { items: [HELENA_REQUEST] },
        });
        fake.on(
          `POST /v1/connections/requests/${HELENA_REQUEST.id}/accept`,
          apiError(410, 'REQUEST_EXPIRED'),
        );
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    await userEvent.press(await screen.findByRole('button', { name: COPY.useCamera }));
    await fireEvent(await screen.findByTestId('qr-camera'), 'barcodeScanned', {
      data: proximityQrPayload(HELENA_TOKEN),
    });
    expect(await screen.findByText(COPY.expired('Helena'))).toBeOnTheScreen();
    expect(screen.queryByTestId('folha-pedido')).not.toBeOnTheScreen();
  });

  it('ux.md §4.11: no fim do prazo a folha fecha sozinha com o Toast', async () => {
    await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        fake.on('GET /v1/connections/requests/incoming', {
          status: 200,
          body: { items: [incomingRequest({ expiresInS: 1 })] },
        });
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_100);
    });
    expect(await screen.findByText(COPY.expired('Helena'))).toBeOnTheScreen();
    expect(screen.queryByTestId('folha-pedido')).not.toBeOnTheScreen();
  });
  it('PROX-61 (folha): ‹Bloquear› abre o Alert do perfil; "Bloquear" manda POST /me/blocks {handle} e a folha fecha', async () => {
    const alert = jest.spyOn(Alert, 'alert');
    const { api } = await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureHelena(fake);
        fake.on('POST /v1/me/blocks', { status: 204 });
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    await userEvent.press(screen.getByTestId('folha-pedido-bloquear'));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]?.[0]).toBe(blockTitle('helena'));
    const buttons = alert.mock.calls[0]?.[2] ?? [];
    await act(async () => {
      buttons.find((button) => button.text === 'Bloquear')?.onPress?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.callsTo('POST /v1/me/blocks')[0]?.body).toEqual({ handle: 'helena' });
    });
    expect(await screen.findByText(blockedMessage('helena'))).toBeOnTheScreen();
    await waitFor(() => {
      expect(screen.queryByTestId('folha-pedido')).not.toBeOnTheScreen();
    });
  });

  it('PROX-62 (folha): ‹Denunciar› abre o formulário por cima da tela Conectar; o 202 volta à folha com o Toast', async () => {
    await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureHelena(fake);
        fake.on('POST /v1/reports', { status: 202 });
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    await userEvent.press(screen.getByTestId('folha-pedido-denunciar'));
    expect(await screen.findByTestId('conectar-denunciar')).toBeOnTheScreen();
    expect(screen.queryByTestId('folha-pedido')).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('radio', { name: 'Spam ou golpe' }));
    await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText(REPORT_SENT_MESSAGE)).toBeOnTheScreen();
    // O pedido continua: a folha volta.
    expect(
      await screen.findByRole('header', { name: 'Helena quer se conectar' }),
    ).toBeOnTheScreen();
  });
});

describe('emissão com outra tela por cima (Adendo B1, revisão do seguranca)', () => {
  it('NFC-09: com o formulário de denúncia por cima do QR, o NFC para de emitir; ao fechar, emite de novo', async () => {
    const nfc = createFakeNfc();
    await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      nfc,
      configure: (fake) => {
        configureHelena(fake);
        fake.on('POST /v1/reports', { status: 202 });
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    await waitFor(() => {
      expect(nfc.emitted).not.toBeNull();
    });
    await userEvent.press(screen.getByTestId('folha-pedido-denunciar'));
    expect(await screen.findByTestId('conectar-denunciar')).toBeOnTheScreen();
    await waitFor(() => {
      expect(nfc.emitted).toBeNull();
    });
    await userEvent.press(screen.getByRole('radio', { name: 'Spam ou golpe' }));
    await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText(REPORT_SENT_MESSAGE)).toBeOnTheScreen();
    await waitFor(() => {
      expect(nfc.emitted).not.toBeNull();
    });
  });

  it('NFC-09 (câmera): com a câmera do aceite por cima do QR, o NFC para de emitir; fechada a câmera, emite de novo', async () => {
    const nfc = createFakeNfc();
    await openHelena(nfc);
    await waitFor(() => {
      expect(nfc.emitted).toMatch(/^sussurro:\/\/c\//);
    });
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    // A folha do aceite ainda deixa o QR por baixo: a emissão continua até a câmera abrir.
    expect(nfc.emitted).toMatch(/^sussurro:\/\/c\//);
    await userEvent.press(await screen.findByRole('button', { name: COPY.useCamera }));
    expect(await screen.findByTestId('qr-camera')).toBeOnTheScreen();
    await waitFor(() => {
      expect(nfc.emitted).toBeNull();
    });
    // O apagar é explícito (`null` no histórico), não só a falta de um código novo.
    expect(nfc.emittedHistory.at(-1)).toBeNull();

    await userEvent.press(screen.getByRole('button', { name: COPY.close }));
    await waitFor(() => {
      expect(screen.queryByTestId('qr-scanner')).not.toBeOnTheScreen();
    });
    await waitFor(() => {
      expect(nfc.emitted).toMatch(/^sussurro:\/\/c\//);
    });
  });
});

describe('simulações em dev (4.11, D15)', () => {
  it.each([
    ['qr', COPY.simulate],
    ['nfc', COPY.simulateNfc],
  ] as const)(
    '4.11 CA1: "%s" — o pedido simulado de uma persona aceita com o token devolvido (faz as vezes da leitura)',
    async (method, label) => {
      jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(true);
      const simulated = incomingRequest({
        id: '01a189e0-af57-7000-85fe-2054e618fe04',
        method,
        other: { handle: 'lucasf', name: 'Lucas Ferreira', avatarUrl: null },
      });
      const { api } = await renderApp({
        signedInAs: ME,
        initialUrl: '/pessoal/conectar',
        configure: (fake) => {
          configureConnect(fake);
          fake.on('POST /v1/dev/simulate-request', {
            status: 201,
            body: { request: simulated, observedToken: LUCAS_TOKEN },
          });
          fake.on(`POST /v1/connections/requests/${simulated.id}/accept`, {
            status: 200,
            body: { ...simulated, status: 'accepted', expiresInS: 0 },
          });
        },
      });
      await userEvent.press(await screen.findByRole('button', { name: label }));
      expect(api.callsTo('POST /v1/dev/simulate-request')[0]?.body).toEqual({ method });
      expect(
        await screen.findByRole('header', { name: 'Lucas quer se conectar' }),
      ).toBeOnTheScreen();
      await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
      expect(
        await screen.findByRole('header', { name: 'Você e Lucas estão conectados' }),
      ).toBeOnTheScreen();
      expect(api.callsTo(`POST /v1/connections/requests/${simulated.id}/accept`)[0]?.body).toEqual({
        observedToken: LUCAS_TOKEN,
      });
    },
  );

  it('4.11 CA3: fora do build de desenvolvimento, as simulações não existem', async () => {
    jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(false);
    await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: configureConnect,
    });
    expect(await screen.findByTestId('conectar-mostrar')).toBeOnTheScreen();
    for (const label of [COPY.simulate, COPY.simulateNfc]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    await userEvent.press(screen.getByRole('radio', { name: COPY.modeRead }));
    expect(await screen.findByRole('button', { name: COPY.useCamera })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: COPY.simulate })).toBeNull();
  });
});
