import { userEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';

import { COPY } from './copy';
import * as devTools from './dev-tools';
import { connectTiming } from './timing';
import { createFakeRadio } from '../../../modules/sussurro-proximity/src/fake-radio';
import {
  apiError,
  configureConnect,
  HELENA_TOKEN,
  incomingRequest,
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
const HELENA_TOKEN_2 = 'HelenaTokenDDDD2';
const ME = personalMe({ handle: 'caio.r', name: 'Caio Ribeiro' });

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, resolveMinIntervalMs: 0, tickMs: 20 });
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('pedido recebido (4.6)', () => {
  it('4.6 CA1/CA10: com a tela aberta, a folha "Helena quer se conectar" aparece; uma por vez', async () => {
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
    // Uma folha por vez: Tomás espera a vez.
    expect(screen.queryByRole('header', { name: 'Tomás quer se conectar' })).toBeNull();

    await userEvent.press(screen.getByRole('button', { name: COPY.decline }));
    expect(await screen.findByRole('header', { name: 'Tomás quer se conectar' })).toBeOnTheScreen();
    expect(api.callsTo(`POST /v1/connections/requests/${HELENA_REQUEST.id}/decline`)).toHaveLength(
      1,
    );
  });

  it('PROX-26 / 4.6 CA2/CA7: aceite com o token mais recente de Helena visto na varredura → "Conectados"', async () => {
    const radio = createFakeRadio();
    const { api } = await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/resolve', ({ body }) => ({
          status: 200,
          body: {
            items: (body as { tokens: string[] }).tokens.map((token) =>
              nearbyPerson({ token, handle: 'helena', name: 'Helena Souza' }),
            ),
          },
        }));
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

    // A folha de um pedido por Bluetooth faz o aparelho varrer (sem pedir permissão de novo).
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    // O token de Helena muda com a folha aberta: vale o mais recente.
    await act(async () => {
      radio.emitSighting(HELENA_TOKEN, -58);
      await Promise.resolve();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      radio.emitSighting(HELENA_TOKEN_2, -58);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.callsTo('POST /v1/proximity/resolve')).toHaveLength(2);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
    });

    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(
      await screen.findByRole('header', { name: 'Você e Helena estão conectados' }),
    ).toBeOnTheScreen();
    expect(
      api.callsTo(`POST /v1/connections/requests/${HELENA_REQUEST.id}/accept`)[0]?.body,
    ).toEqual({ observedToken: HELENA_TOKEN_2 });
    expect(screen.queryByTestId('folha-pedido')).not.toBeOnTheScreen();
  });

  it('4.6 CA3: sem ter visto o anúncio de quem pediu, o aceite não é enviado', async () => {
    const { api } = await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      radio: createFakeRadio({ permission: 'undetermined' }),
      configure: (fake) => {
        configureConnect(fake);
        fake.on('GET /v1/connections/requests/incoming', {
          status: 200,
          body: { items: [HELENA_REQUEST] },
        });
      },
    });
    await screen.findByRole('header', { name: 'Helena quer se conectar' });
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(await screen.findByTestId('folha-pedido-erro')).toHaveTextContent(
      COPY.notSeen('Helena'),
    );
    expect(api.callsTo(`POST /v1/connections/requests/${HELENA_REQUEST.id}/accept`)).toHaveLength(
      0,
    );
  });

  it('4.6 CA6: aceite de pedido vencido (410) → a folha fecha com "O pedido de Helena expirou."', async () => {
    const radio = createFakeRadio();
    await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      radio,
      configure: (fake) => {
        configureConnect(fake);
        fake.on('POST /v1/proximity/resolve', {
          status: 200,
          body: {
            items: [nearbyPerson({ token: HELENA_TOKEN, handle: 'helena', name: 'Helena Souza' })],
          },
        });
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
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    await act(async () => {
      radio.emitSighting(HELENA_TOKEN, -58);
      await Promise.resolve();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60);
    });
    await userEvent.press(screen.getByRole('button', { name: COPY.accept }));
    expect(await screen.findByText(COPY.expired('Helena'))).toBeOnTheScreen();
    await waitFor(() => {
      expect(screen.queryByTestId('folha-pedido')).not.toBeOnTheScreen();
    });
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

describe('simular um pedido recebido (4.11, D15)', () => {
  it('4.11 CA1: em dev, o botão cria o pedido de uma persona e o aceite usa o token devolvido', async () => {
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
          body: { request: simulated, observedToken: 'LucasTokenFFFFF1' },
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
    expect(api.callsTo(`POST /v1/connections/requests/${simulated.id}/accept`)[0]?.body).toEqual({
      observedToken: 'LucasTokenFFFFF1',
    });
  });

  it('4.11 CA3: fora do build de desenvolvimento, o botão não existe', async () => {
    jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(false);
    await renderApp({
      signedInAs: ME,
      initialUrl: '/pessoal/conectar',
      configure: configureConnect,
    });
    expect(await screen.findByText(COPY.intro)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: COPY.simulate })).toBeNull();
    await userEvent.press(screen.getByRole('radio', { name: 'QR code' }));
    expect(await screen.findByRole('button', { name: COPY.readTheirCode })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: COPY.simulate })).toBeNull();
  });
});
