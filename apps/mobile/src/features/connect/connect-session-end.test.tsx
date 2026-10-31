import type { Me } from '@sussurro/shared';
import { fireEvent, userEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { COPY } from './copy';
import * as haptics from './haptics';
import { connectTiming } from './timing';
import { TOUCH_CALIBRATION } from './touch-calibration';
import { resetTouchReportGate } from './useTouch';
import {
  createFakeRadio,
  type FakeRadio,
} from '../../../modules/sussurro-proximity/src/fake-radio';
import { cameraMock } from '../../test-utils/camera-mock';
import {
  apiError,
  CAIO_TOKEN,
  configureConnect,
  mutualTouches,
  nearbyPerson,
} from '../../test-utils/connect-fixtures';
import { type FakeApi, personalMe, session, tokenPair } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';

// PROX-69 (ADR 0012, A3-3 item 5; BAIXO da 2ª passada do `seguranca`): o último cartão mostrado
// fica no módulo, fora da tela, e é da conta. Quando a sessão termina (sair, sessão expirada ou
// revogada) e na troca de conta, o @ sai da memória. A conta que entra em seguida recebe o cartão
// do mesmo @ em menos de 10 s e ele aparece. Sem sair, a reentrega continua ignorada.

const SAVED_TIMING = { ...connectTiming };
const CAL = TOUCH_CALIBRATION;
const TX_REF = CAL.advertiserTxDbm;
const CAIO = nearbyPerson();
const HELENA = personalMe();
const MARINA = personalMe({
  id: '01a189e0-af57-7000-85fe-2054e618feb1',
  email: 'marina@example.com',
  handle: 'marina',
  name: 'Marina Costa',
});

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function touch(radio: FakeRadio) {
  for (let elapsed = 0; elapsed < 1400; elapsed += CAL.sightingMinIntervalMs) {
    await act(async () => {
      radio.emitSighting(CAIO_TOKEN, TX_REF - 30);
      await jest.advanceTimersByTimeAsync(CAL.sightingMinIntervalMs);
    });
  }
}

/** Confirma o "Sair da conta?" (o botão destrutivo). */
function confirmAlerts() {
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons?: AlertButton[]) => {
    buttons?.find((button) => button.style === 'destructive')?.onPress?.();
  });
}

async function openConnect(radio: FakeRadio) {
  await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
  expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
  await waitFor(() => {
    expect(radio.scanning).toBe(true);
  });
}

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

type Leave = 'stay' | 'signOut' | 'expired';

/** Como a conta de Helena deixa o Conectar depois do cartão de Caio. */
async function leave(how: Leave, api: FakeApi) {
  if (how === 'expired') {
    // A sessão é revogada em outro aparelho: o próximo 401 pede o refresh, que é recusado.
    api.on('GET /v1/connections/requests/incoming', apiError(401, 'UNAUTHORIZED'));
    api.on('POST /v1/auth/refresh', apiError(401, 'UNAUTHORIZED'));
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    api.on('GET /v1/connections/requests/incoming', { status: 200, body: { items: [] } });
    api.on('POST /v1/auth/refresh', () => ({ status: 200, body: tokenPair() }));
    return;
  }
  await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
  expect(await screen.findByRole('header', { name: HELENA.handle })).toBeOnTheScreen();
  if (how === 'signOut') {
    await userEvent.press(screen.getByRole('button', { name: 'Sair da conta' }));
  }
}

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, tickMs: 20 });
  resetTouchReportGate();
  cameraMock.reset();
  jest.spyOn(haptics, 'vibrate').mockImplementation(() => undefined);
  confirmAlerts();
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

describe('Conectar: o último cartão é da sessão (PROX-69; ADR 0012, A3-3 item 5)', () => {
  it.each<{ when: string; how: Leave; next: Me | null; shown: boolean; result: string }>([
    {
      when: 'sem sair (Perfil e de volta ao Conectar)',
      how: 'stay',
      next: null,
      shown: false,
      result: 'continua ignorado',
    },
    {
      when: 'saiu e entrou outra conta',
      how: 'signOut',
      next: MARINA,
      shown: true,
      result: 'aparece',
    },
    {
      when: 'saiu e entrou de novo a mesma conta',
      how: 'signOut',
      next: HELENA,
      shown: true,
      result: 'aparece',
    },
    {
      when: 'a sessão expirou (refresh recusado) e entrou outra conta',
      how: 'expired',
      next: MARINA,
      shown: true,
      result: 'aparece',
    },
  ])(
    'PROX-69: $when → o cartão do mesmo @ que chega em menos de 10 s $result',
    async ({ how, next, shown }) => {
      const radio = createFakeRadio();
      const { api } = await renderApp({
        signedInAs: HELENA,
        initialUrl: '/pessoal/conectar',
        radio,
        configure: (fake) => {
          configureConnect(fake);
          fake.on('POST /v1/proximity/touches', mutualTouches({ [CAIO_TOKEN]: CAIO }));
          fake.on('POST /v1/auth/logout', { status: 204 });
        },
      });
      expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
      await waitFor(() => {
        expect(radio.scanning).toBe(true);
      });
      await touch(radio);
      expect(await screen.findByRole('header', { name: CAIO.name })).toBeOnTheScreen();
      const cardAt = Date.now();
      await userEvent.press(screen.getByRole('button', { name: COPY.cancel }));
      expect(await screen.findByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();

      await leave(how, api);
      if (next !== null) await signInAs(api, next);
      await openConnect(radio);
      const reportsBefore = api.callsTo('POST /v1/proximity/touches').length;
      // O servidor reentrega o cartão de Caio no relato seguinte (o par ainda está vivo).
      await touch(radio);
      if (shown) {
        expect(await screen.findByRole('header', { name: CAIO.name })).toBeOnTheScreen();
        expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
      } else {
        await advance(cardAt + CAL.cardRedeliveryMs - 300 - Date.now());
        expect(screen.queryByTestId('conectar-encostado')).toBeNull();
        expect(screen.getByRole('header', { name: COPY.readyTitle })).toBeOnTheScreen();
      }
      // Tudo dentro da reentrega: fora dela, o cartão apareceria de qualquer jeito.
      expect(Date.now() - cardAt).toBeLessThan(CAL.cardRedeliveryMs);
      // O relato depois da volta ao Conectar saiu, e todo relato desse @ depois do 1º traz o cartão
      // (`mutualTouches`): o cartão reentregue chegou ao app. Sem isso, o "continua ignorado"
      // passaria também com um app que não relata nada.
      expect(api.callsTo('POST /v1/proximity/touches').length).toBeGreaterThan(reportsBefore);
    },
  );
});
