import { userEvent } from '@testing-library/react-native';
import { act, screen } from 'expo-router/testing-library';
import { AccessibilityInfo } from 'react-native';

import { COPY } from './copy';
import * as devTools from './dev-tools';
import * as haptics from './haptics';
import { connectTiming } from './timing';
import { resetTouchReportGate } from './useTouch';
import { createFakeRadio } from '../../../modules/sussurro-proximity/src/fake-radio';
import {
  apiError,
  configureConnect,
  incomingRequest,
  mutualTouches,
  nearbyPerson,
} from '../../test-utils/connect-fixtures';
import { personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';

const SAVED_TIMING = { ...connectTiming };
const HELENA_REQUEST = incomingRequest();
const TOMAS_REQUEST = incomingRequest({
  id: '01a189e0-af57-7000-85fe-2054e618fe03',
  other: { handle: 'tomas', name: 'Tomás Lima', avatarUrl: null },
});
const ME = personalMe({ handle: 'caio.r', name: 'Caio Ribeiro' });
const LUCAS_BLE = 'LucasBleTokenFF1';

const queued = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
const focus = jest.mocked(AccessibilityInfo.sendAccessibilityEvent);

/** O `testID` de cada elemento que recebeu o foco (o `ref` é a instância do `View`). */
function focusedTestIds(): unknown[] {
  return focus.mock.calls.map(
    ([target]) => (target as unknown as { props?: { testID?: unknown } }).props?.testID,
  );
}

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, tickMs: 20 });
  // O ritmo e o orçamento do relato ficam no módulo (ADR 0012, A2 rev. 1, R1-3).
  resetTouchReportGate();
  jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
  queued.mockClear();
  focus.mockClear();
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('pedido recebido na folha (4.6, ux.md §4.11)', () => {
  it('4.6 CA1/CA10: com a tela aberta, a folha "Helena quer se conectar" aparece; uma por vez; vibra leve; o foco vai ao título e o A5 sai depois, em fila', async () => {
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

  it('ADR 0012 §4: o aceite de um pedido por encostar vai sem token, sem varrer nada a mais', async () => {
    const radio = createFakeRadio({ permission: 'undetermined' });
    const { api } = await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureConnect(fake);
        let accepted = false;
        fake.on('GET /v1/connections/requests/incoming', () => ({
          status: 200,
          body: { items: accepted ? [] : [HELENA_REQUEST] },
        }));
        fake.on(`POST /v1/connections/requests/${HELENA_REQUEST.id}/accept`, () => {
          accepted = true;
          return { status: 200, body: { ...HELENA_REQUEST, status: 'accepted', expiresInS: 0 } };
        });
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    // A folha de um pedido por encostar não liga a varredura (o par já provou o encontro).
    expect(radio.scanning).toBe(false);
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(
      await screen.findByRole('header', { name: 'Você e Helena estão conectados' }),
    ).toBeOnTheScreen();
    expect(
      api.callsTo(`POST /v1/connections/requests/${HELENA_REQUEST.id}/accept`)[0]?.body,
    ).toEqual({});
    expect(screen.queryByTestId('folha-pedido')).not.toBeOnTheScreen();
  });

  it('T35: o aceite por encostar recusado pelo servidor mostra "Encoste o seu celular no de Helena…" e o pedido continua', async () => {
    const { api } = await renderApp({
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
          apiError(400, 'PROXIMITY_TOKEN_INVALID'),
        );
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(await screen.findByTestId('folha-pedido-erro')).toHaveTextContent(
      COPY.notSeen('Helena'),
    );
    expect(screen.getByTestId('folha-pedido')).toBeOnTheScreen();
    expect(api.callsTo(`POST /v1/connections/requests/${HELENA_REQUEST.id}/accept`)).toHaveLength(
      1,
    );
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
});

describe('simulações em dev (4.11 e ADR 0012 §7, D15)', () => {
  it('4.11 CA1: "Simular um pedido recebido" cria o pedido de uma persona; o aceite por encostar vai sem token', async () => {
    jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(true);
    const simulated = incomingRequest({
      id: '01a189e0-af57-7000-85fe-2054e618fe04',
      other: { handle: 'lucasf', name: 'Lucas Ferreira', avatarUrl: null },
    });
    const { api } = await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/dev/simulate-request', {
          status: 201,
          body: { request: simulated, observedToken: 'LucasQrTokenFFF1' },
        });
        fake.on(`POST /v1/connections/requests/${simulated.id}/accept`, {
          status: 200,
          body: { ...simulated, status: 'accepted', expiresInS: 0 },
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: COPY.simulate }));
    expect(await screen.findByRole('header', { name: 'Lucas quer se conectar' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(
      await screen.findByRole('header', { name: 'Você e Lucas estão conectados' }),
    ).toBeOnTheScreen();
    expect(api.callsTo(`POST /v1/connections/requests/${simulated.id}/accept`)[0]?.body).toEqual(
      {},
    );
  });

  it('4.11: o pedido simulado por QR aceita com o qrToken devolvido (sem segundo aparelho)', async () => {
    jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(true);
    const simulated = incomingRequest({
      id: '01a189e0-af57-7000-85fe-2054e618fe05',
      method: 'qr',
      other: { handle: 'tomas', name: 'Tomás Lima', avatarUrl: null },
    });
    const { api } = await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/dev/simulate-request', {
          status: 201,
          body: { request: simulated, observedToken: 'TomasQrTokenGGG1' },
        });
        fake.on(`POST /v1/connections/requests/${simulated.id}/accept`, {
          status: 200,
          body: { ...simulated, status: 'accepted', expiresInS: 0 },
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: COPY.simulate }));
    await userEvent.press(await screen.findByRole('button', { name: COPY.accept }));
    await screen.findByRole('header', { name: 'Você e Tomás estão conectados' });
    expect(api.callsTo(`POST /v1/connections/requests/${simulated.id}/accept`)[0]?.body).toEqual({
      observedToken: 'TomasQrTokenGGG1',
    });
  });

  it('ADR 0012 §7: "Simular o outro celular encostando" relata o bleToken da persona e abre o cartão', async () => {
    jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(true);
    const lucas = nearbyPerson({ token: LUCAS_BLE, handle: 'lucasf', name: 'Lucas Ferreira' });
    const { api } = await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/dev/simulate-touch', { status: 201, body: { bleToken: LUCAS_BLE } });
        fake.on('POST /v1/proximity/touches', mutualTouches({ [LUCAS_BLE]: lucas }, 0));
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: COPY.simulateTouch }));
    expect(await screen.findByRole('header', { name: 'Lucas Ferreira' })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/proximity/touches')[0]?.body).toEqual({ tokens: [LUCAS_BLE] });
  });

  it('4.11 CA3: fora do build de desenvolvimento, as simulações e a calibração não existem', async () => {
    jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(false);
    await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: configureConnect,
    });
    expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
    for (const label of [COPY.simulate, COPY.simulateTouch, COPY.calibration]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    await userEvent.press(screen.getByRole('radio', { name: 'QR code' }));
    expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: COPY.simulate })).toBeNull();
  });
});
