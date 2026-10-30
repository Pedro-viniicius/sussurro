import { userEvent } from '@testing-library/react-native';
import { act, fireEvent, screen, waitFor } from 'expo-router/testing-library';
import { Alert, type AlertButton, AppState, type AppStateStatus } from 'react-native';

import {
  PUSH_ENABLE_FAILED,
  PUSH_PROMPT_ENABLE,
  PUSH_PROMPT_LATER,
  PUSH_PROMPT_TITLE,
} from './NotificationsProvider';
import { pushRouteFor } from './push-route';
import { configureConnect, incomingRequest } from '../../test-utils/connect-fixtures';
import { creatorMe, personalMe } from '../../test-utils/fake-api';
import { createFakePush, FAKE_PUSH_TOKEN, type FakePush } from '../../test-utils/fake-push';
import { AUTHORS, textPost } from '../../test-utils/post-fixtures';
import { renderApp, type RenderAppOptions } from '../../test-utils/render-app';
import { PUSH_BLOCKED_TITLE, PUSH_SETTING_LABEL } from '../account/ContaScreen';
import { COPY } from '../connect/copy';
import * as devTools from '../connect/dev-tools';
import { connectTiming } from '../connect/timing';

const ME = personalMe();
const SAVED_TIMING = { ...connectTiming };

beforeEach(() => {
  Object.assign(connectTiming, { pollMs: 20, resolveMinIntervalMs: 0, tickMs: 20 });
});

afterEach(() => {
  Object.assign(connectTiming, SAVED_TIMING);
  jest.restoreAllMocks();
});

/** Responde ao pedido contextual com o botão deste texto (ou só registra, sem `answer`). */
function spyAlert(answer?: string) {
  return jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      if (answer === undefined) return;
      buttons?.find((button) => button.text === answer)?.onPress?.();
    });
}

function promptCalls(alert: jest.SpyInstance) {
  return alert.mock.calls.filter(([title]) => title === PUSH_PROMPT_TITLE);
}

/** Publica um texto pelo Criar (o "primeiro post" do pedido contextual, 6.4 CA1). */
async function publishText(text = 'Café coado e chuva.') {
  await userEvent.press(await screen.findByRole('tab', { name: 'Criar publicação' }));
  await screen.findByRole('header', { name: 'Nova publicação' });
  await userEvent.press(screen.getByRole('tab', { name: 'Texto' }));
  await userEvent.type(screen.getByLabelText('Texto da publicação'), text);
  await userEvent.press(screen.getByRole('button', { name: 'Compartilhar' }));
  await waitFor(() => {
    expect(screen).toHavePathname('/pessoal/inicio');
  });
}

function postReply() {
  return {
    status: 201,
    body: textPost({ isOwn: true, author: AUTHORS.helena, text: 'Café coado e chuva.' }),
  };
}

describe('PushDataSchema antes de navegar (6.5 CA5, 6.6)', () => {
  it('aceita só a rota que o servidor monta para o tipo e a conta', () => {
    expect(
      pushRouteFor({ type: 'post_liked', url: '/pessoal/inicio/notificacoes' }, 'personal'),
    ).toBe('/pessoal/inicio/notificacoes');
    expect(pushRouteFor({ type: 'new_followers', url: '/criador/notificacoes' }, 'creator')).toBe(
      '/criador/notificacoes',
    );
    expect(pushRouteFor({ type: 'connection_request', url: '/pessoal/conectar' }, 'personal')).toBe(
      '/pessoal/conectar',
    );
  });

  it.each([
    ['sem data', undefined],
    ['texto', 'ExponentPushToken[x]'],
    ['tipo desconhecido', { type: 'post_shared', url: '/pessoal/inicio/notificacoes' }],
    ['sem url', { type: 'post_liked' }],
    ['url externa', { type: 'post_liked', url: 'https://golpe.example/entrar' }],
    ['url relativa sem barra', { type: 'post_liked', url: 'pessoal/inicio/notificacoes' }],
    ['outra rota do app', { type: 'post_liked', url: '/conta/excluir' }],
    ['rota do outro tipo de conta', { type: 'post_liked', url: '/criador/notificacoes' }],
    ['tipo trocado', { type: 'connection_request', url: '/pessoal/inicio/notificacoes' }],
  ])('recusa data inválido: %s', (_name, data) => {
    expect(pushRouteFor(data, 'personal')).toBeNull();
  });
});

describe('registro do token (6.4)', () => {
  it('6.4 CA1: a cada abertura com sessão, quem ativou registra o token (PUT /me/push-tokens)', async () => {
    const push = createFakePush({
      permission: { status: 'granted', canAskAgain: true },
      states: { [ME.id]: { choice: 'on', token: FAKE_PUSH_TOKEN } },
    });
    const { api } = await renderApp({
      signedInAs: ME,
      push,
      configure: (fake) => {
        fake.on('PUT /v1/me/push-tokens', { status: 204 });
      },
    });
    await waitFor(() => {
      expect(api.callsTo('PUT /v1/me/push-tokens')).toHaveLength(1);
    });
    expect(api.callsTo('PUT /v1/me/push-tokens')[0]?.body).toEqual({
      expoToken: FAKE_PUSH_TOKEN,
      platform: 'ios',
    });
    // O token vai no corpo, nunca na URL.
    expect(api.callsTo('PUT /v1/me/push-tokens')[0]?.query).toEqual({});
    expect(push.requests).toBe(0);
  });

  it('6.4 CA4: sem ter ativado neste aparelho, nada é registrado (mesmo com a permissão do sistema)', async () => {
    const neverAsked = createFakePush({ permission: { status: 'granted', canAskAgain: true } });
    const first = await renderApp({ signedInAs: ME, push: neverAsked });
    await screen.findByTestId('tela-inicio');
    expect(first.api.callsTo('PUT /v1/me/push-tokens')).toHaveLength(0);
    expect(neverAsked.tokenCalls).toBe(0);
  });

  it('permissão retirada nos Ajustes: não registra nem pede de novo', async () => {
    const revoked = createFakePush({
      permission: { status: 'denied', canAskAgain: false },
      states: { [ME.id]: { choice: 'on', token: FAKE_PUSH_TOKEN } },
    });
    const second = await renderApp({ signedInAs: ME, push: revoked });
    await screen.findByTestId('tela-inicio');
    expect(second.api.callsTo('PUT /v1/me/push-tokens')).toHaveLength(0);
    expect(revoked.requests).toBe(0);
  });

  it('AUTH-12/6.4 CA2: sair deste aparelho não chama o DELETE (o logout apaga o token no servidor)', async () => {
    const push = createFakePush({
      permission: { status: 'granted', canAskAgain: true },
      states: { [ME.id]: { choice: 'on', token: FAKE_PUSH_TOKEN } },
    });
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons?: AlertButton[]) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    const { api } = await renderApp({
      signedInAs: ME,
      push,
      initialUrl: '/conta',
      configure: (fake) => {
        fake.on('PUT /v1/me/push-tokens', { status: 204 });
        fake.on('POST /v1/auth/logout', { status: 204 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Sair deste dispositivo' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(api.callsTo('POST /v1/auth/logout')).toHaveLength(1);
    expect(api.callsTo('DELETE /v1/me/push-tokens')).toHaveLength(0);
  });
});

describe('pedido contextual (6.4 CA1 e CA4; ux.md §4.12)', () => {
  it('6.4 CA1: no primeiro post, "Ativar" pede a permissão do sistema e registra o token', async () => {
    const push = createFakePush();
    const alert = spyAlert(PUSH_PROMPT_ENABLE);
    const { api } = await renderApp({
      signedInAs: ME,
      push,
      configure: (fake) => {
        fake.on('POST /v1/posts', postReply());
        fake.on('PUT /v1/me/push-tokens', { status: 204 });
      },
    });
    await publishText();
    await waitFor(() => {
      expect(api.callsTo('PUT /v1/me/push-tokens')).toHaveLength(1);
    });
    expect(promptCalls(alert)).toHaveLength(1);
    expect(push.requests).toBe(1);
    expect(push.stored.get(ME.id)).toEqual({ choice: 'on', token: FAKE_PUSH_TOKEN });
  });

  it('6.4 CA4: "Agora não" não pede ao sistema e o app não pergunta de novo no post seguinte', async () => {
    const push = createFakePush();
    const alert = spyAlert(PUSH_PROMPT_LATER);
    const { api } = await renderApp({
      signedInAs: ME,
      push,
      configure: (fake) => {
        fake.on('POST /v1/posts', postReply);
      },
    });
    await publishText();
    await waitFor(() => {
      expect(promptCalls(alert)).toHaveLength(1);
    });
    await publishText('Outro texto.');
    await waitFor(() => {
      expect(api.callsTo('POST /v1/posts')).toHaveLength(2);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(promptCalls(alert)).toHaveLength(1);
    expect(push.requests).toBe(0);
    expect(api.callsTo('PUT /v1/me/push-tokens')).toHaveLength(0);
    expect(push.stored.get(ME.id)?.choice).toBe('off');
  });

  it('6.4 CA4: negada no sistema, nada quebra, nada é registrado e não há novo pedido', async () => {
    const push = createFakePush({ answer: { status: 'denied', canAskAgain: false } });
    const alert = spyAlert(PUSH_PROMPT_ENABLE);
    const { api } = await renderApp({
      signedInAs: ME,
      push,
      configure: (fake) => {
        fake.on('POST /v1/posts', postReply);
      },
    });
    await publishText();
    await waitFor(() => {
      expect(push.requests).toBe(1);
    });
    await publishText('Outro texto.');
    await waitFor(() => {
      expect(api.callsTo('POST /v1/posts')).toHaveLength(2);
    });
    expect(promptCalls(alert)).toHaveLength(1);
    expect(push.requests).toBe(1);
    expect(api.callsTo('PUT /v1/me/push-tokens')).toHaveLength(0);
  });

  it('6.4 CA4: com a permissão negada de vez antes, o app nem pergunta', async () => {
    const push = createFakePush({ permission: { status: 'denied', canAskAgain: false } });
    const alert = spyAlert(PUSH_PROMPT_ENABLE);
    const { api } = await renderApp({
      signedInAs: ME,
      push,
      configure: (fake) => {
        fake.on('POST /v1/posts', postReply);
      },
    });
    await publishText();
    await waitFor(() => {
      expect(push.stored.get(ME.id)?.choice).toBe('off');
    });
    expect(promptCalls(alert)).toHaveLength(0);
    expect(push.requests).toBe(0);
    expect(api.callsTo('PUT /v1/me/push-tokens')).toHaveLength(0);
  });

  it('sem token (sem o projectId do EAS ou sem rede): aviso e nada é registrado', async () => {
    const push = createFakePush({ tokenFails: true });
    spyAlert(PUSH_PROMPT_ENABLE);
    const { api } = await renderApp({
      signedInAs: ME,
      push,
      configure: (fake) => {
        fake.on('POST /v1/posts', postReply);
      },
    });
    await publishText();
    // O Toast entra na fila depois do "Publicado." (4 s).
    expect(await screen.findByText(PUSH_ENABLE_FAILED, {}, { timeout: 7000 })).toBeOnTheScreen();
    expect(api.callsTo('PUT /v1/me/push-tokens')).toHaveLength(0);
    expect(push.stored.get(ME.id)?.choice).toBe('off');
  }, 15_000);

  it('6.4 CA1: a primeira conexão também faz o pedido', async () => {
    jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(true);
    const alert = spyAlert();
    const simulated = incomingRequest({
      id: '01a189e0-af57-7000-85fe-2054e618fe04',
      other: { handle: 'lucasf', name: 'Lucas Ferreira', avatarUrl: null },
    });
    await renderApp({
      signedInAs: personalMe({ handle: 'caio.r', name: 'Caio Ribeiro' }),
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
    await userEvent.press(await screen.findByRole('button', { name: COPY.accept }));
    await screen.findByRole('header', { name: 'Você e Lucas estão conectados' });
    await waitFor(() => {
      expect(promptCalls(alert)).toHaveLength(1);
    });
    expect(promptCalls(alert)[0]?.[1]).toMatch(/se conectar com você/);
  });
});

describe('toque no push (6.5 CA5, 6.6)', () => {
  it('com o app aberto: o data válido abre as Notificações; o inválido não navega', async () => {
    const push = createFakePush();
    await renderApp({ signedInAs: ME, push, initialUrl: '/pessoal/perfil' });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/perfil');
    });
    await screen.findByRole('tab', { name: 'Perfil' });
    await act(async () => {
      push.tap({ type: 'post_liked', url: '/conta/excluir' });
      await Promise.resolve();
    });
    expect(screen).toHavePathname('/pessoal/perfil');
    await act(async () => {
      push.tap({ type: 'post_commented', url: '/pessoal/inicio/notificacoes' });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio/notificacoes');
    });
  });

  it('6.6 CA1: o push de pedido de conexão abre o Conectar', async () => {
    const push = createFakePush();
    await renderApp({
      signedInAs: ME,
      push,
      configure: (fake) => {
        configureConnect(fake);
      },
    });
    await screen.findByTestId('tela-inicio');
    await act(async () => {
      push.tap({ type: 'connection_request', url: '/pessoal/conectar' });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/conectar');
    });
  });

  it('MAN-PUSH-01 (app fechado): o toque que abriu o app espera a sessão e abre a tela do criador', async () => {
    const push = createFakePush({
      launchResponse: { id: 'n-1', data: { type: 'new_followers', url: '/criador/notificacoes' } },
    });
    await renderApp({ signedInAs: creatorMe(), push });
    await waitFor(() => {
      expect(screen).toHavePathname('/criador/notificacoes');
    });
    expect(await screen.findByTestId('tela-notificacoes-criador')).toBeOnTheScreen();
  });

  it('app fechado e sem sessão: só abre o Entrar, sem guardar o destino', async () => {
    const push = createFakePush({
      launchResponse: {
        id: 'n-2',
        data: { type: 'post_liked', url: '/pessoal/inicio/notificacoes' },
      },
    });
    await renderApp({ push });
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
  });

  it('6.2: push recebido e volta ao app atualizam o ponto azul', async () => {
    let unread = 0;
    const push = createFakePush();
    await renderApp({
      signedInAs: ME,
      push,
      configure: (fake) => {
        fake.on('GET /v1/notifications/unread-count', () => ({
          status: 200,
          body: { count: unread },
        }));
      },
    });
    await screen.findByRole('button', { name: 'Notificações' });
    unread = 1;
    await act(async () => {
      push.receive();
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('button', { name: 'Notificações, há novidades' }),
    ).toBeOnTheScreen();
    unread = 0;
    // O mock do React Native guarda os ouvintes do AppState: o último de "change" é o do app.
    const listeners = jest
      .mocked(AppState.addEventListener)
      .mock.calls.filter(([type]) => type === 'change')
      .map(([, listener]) => listener as (state: AppStateStatus) => void);
    await act(async () => {
      listeners.at(-1)?.('active');
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Notificações' })).toBeOnTheScreen();
  });
});

describe('Conta: notificações neste celular (6.4)', () => {
  async function openAccount(push: FakePush, configure?: RenderAppOptions['configure']) {
    const result = await renderApp({
      signedInAs: ME,
      push,
      initialUrl: '/conta',
      ...(configure === undefined ? {} : { configure }),
    });
    const toggle = await screen.findByRole('switch', { name: PUSH_SETTING_LABEL });
    return { ...result, toggle };
  }

  it('desligar chama o DELETE com o token no corpo e para de registrar', async () => {
    const push = createFakePush({
      permission: { status: 'granted', canAskAgain: true },
      states: { [ME.id]: { choice: 'on', token: FAKE_PUSH_TOKEN } },
    });
    const { api, toggle } = await openAccount(push, (fake) => {
      fake.on('PUT /v1/me/push-tokens', { status: 204 });
      fake.on('DELETE /v1/me/push-tokens', { status: 204 });
    });
    await waitFor(() => {
      expect(toggle).toHaveProp('value', true);
    });
    await fireEvent(toggle, 'valueChange', false);
    await waitFor(() => {
      expect(api.callsTo('DELETE /v1/me/push-tokens')).toHaveLength(1);
    });
    expect(api.callsTo('DELETE /v1/me/push-tokens')[0]?.body).toEqual({
      expoToken: FAKE_PUSH_TOKEN,
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: PUSH_SETTING_LABEL })).toHaveProp('value', false);
    });
    expect(push.stored.get(ME.id)).toEqual({ choice: 'off', token: null });
  });

  it('sem rede, desligar mostra o erro e continua ligado', async () => {
    const push = createFakePush({
      permission: { status: 'granted', canAskAgain: true },
      states: { [ME.id]: { choice: 'on', token: FAKE_PUSH_TOKEN } },
    });
    const { toggle } = await openAccount(push, (fake) => {
      fake.on('PUT /v1/me/push-tokens', { status: 204 });
      fake.on('DELETE /v1/me/push-tokens', {
        status: 503,
        body: { code: 'SERVICE_UNAVAILABLE', message: 'x' },
      });
    });
    await waitFor(() => {
      expect(toggle).toHaveProp('value', true);
    });
    await fireEvent(toggle, 'valueChange', false);
    expect(
      await screen.findByText('Algo deu errado do nosso lado. Tente de novo.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('switch', { name: PUSH_SETTING_LABEL })).toHaveProp('value', true);
    expect(push.stored.get(ME.id)?.choice).toBe('on');
  });

  it('ligar pede a permissão e registra; negada de vez leva aos Ajustes', async () => {
    const push = createFakePush();
    const { api, toggle } = await openAccount(push, (fake) => {
      fake.on('PUT /v1/me/push-tokens', { status: 204 });
    });
    await waitFor(() => {
      expect(toggle).not.toBeDisabled();
    });
    await fireEvent(toggle, 'valueChange', true);
    await waitFor(() => {
      expect(api.callsTo('PUT /v1/me/push-tokens')).toHaveLength(1);
    });
    expect(push.requests).toBe(1);
  });

  it('negada de vez: ligar leva aos Ajustes, sem pedir ao sistema', async () => {
    const blocked = createFakePush({ permission: { status: 'denied', canAskAgain: false } });
    const alert = spyAlert('Abrir Ajustes');
    const second = await openAccount(blocked);
    await waitFor(() => {
      expect(second.toggle).not.toBeDisabled();
    });
    await fireEvent(second.toggle, 'valueChange', true);
    await waitFor(() => {
      expect(blocked.settingsOpened).toBe(1);
    });
    expect(alert.mock.calls[0]?.[0]).toBe(PUSH_BLOCKED_TITLE);
    expect(blocked.requests).toBe(0);
  });
});
