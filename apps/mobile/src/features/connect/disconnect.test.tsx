import { userEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import {
  DISCONNECT_ACTION,
  DISCONNECT_MESSAGE,
  disconnectedMessage,
  disconnectTitle,
} from './useRemoveConnection';
import { NetworkError } from '../../lib/api/errors';
import { personalMe } from '../../test-utils/fake-api';
import { ownListItem } from '../../test-utils/relation-fixtures';
import { renderApp } from '../../test-utils/render-app';

afterEach(() => {
  jest.restoreAllMocks();
});

function answerAlerts(...texts: string[]) {
  return jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      buttons
        ?.find((button) => button.text !== undefined && texts.includes(button.text))
        ?.onPress?.();
    });
}

const CONNECTIONS = {
  status: 200,
  body: {
    items: [ownListItem(), ownListItem({ handle: 'bia.alves', name: 'Bia Alves' })],
    nextCursor: null,
  },
};

describe('desfazer conexão (4.9, D8)', () => {
  it('4.9 CA1: pelo "···" da lista, com confirmação; a linha some na hora e o número cai', async () => {
    const alert = answerAlerts('Desfazer');
    let removed = false;
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('GET /v1/me/connections', CONNECTIONS);
        fake.on('GET /v1/me', () => ({
          status: 200,
          body: personalMe({
            counts: { posts: 5, connections: removed ? 3 : 4, creators: 3 },
          }),
        }));
        fake.on('DELETE /v1/connections/caio.r', () => {
          removed = true;
          return { status: 204 };
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: '4 conexões' }));
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções para @caio.r' }));
    await userEvent.press(await screen.findByRole('button', { name: DISCONNECT_ACTION }));

    expect(alert).toHaveBeenCalledWith(
      disconnectTitle('caio.r'),
      DISCONNECT_MESSAGE,
      expect.any(Array),
    );
    await waitFor(() => {
      expect(screen.queryByText('caio.r')).not.toBeOnTheScreen();
    });
    expect(screen.getByText('bia.alves')).toBeOnTheScreen();
    expect(api.callsTo('DELETE /v1/connections/caio.r')).toHaveLength(1);
    expect(await screen.findByText(disconnectedMessage('caio.r'))).toBeOnTheScreen();

    // O número de conexões do próprio perfil já caiu.
    await userEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(await screen.findByRole('button', { name: '3 conexões' })).toBeOnTheScreen();
  });

  it('4.9: cancelar no Alert não desfaz nada', async () => {
    answerAlerts('Cancelar');
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil/conexoes',
      configure: (fake) => {
        fake.on('GET /v1/me/connections', CONNECTIONS);
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções para @caio.r' }));
    await userEvent.press(await screen.findByRole('button', { name: DISCONNECT_ACTION }));
    expect(screen.getByText('caio.r')).toBeOnTheScreen();
    expect(api.callsTo('DELETE /v1/connections/caio.r')).toHaveLength(0);
  });

  it('falha de rede: a linha volta e aparece o Toast', async () => {
    answerAlerts('Desfazer');
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil/conexoes',
      configure: (fake) => {
        fake.on('GET /v1/me/connections', CONNECTIONS);
        fake.on('DELETE /v1/connections/caio.r', () => {
          throw new NetworkError();
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções para @caio.r' }));
    await userEvent.press(await screen.findByRole('button', { name: DISCONNECT_ACTION }));
    expect(await screen.findByText('Sem conexão com a internet. Tente de novo.')).toBeOnTheScreen();
    expect(screen.getByText('caio.r')).toBeOnTheScreen();
  });

  it('ux.md §4.9: no perfil da conexão, (Conectados) abre "Desfazer conexão" e sai do perfil', async () => {
    answerAlerts('Desfazer');
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil/conexoes',
      configure: (fake) => {
        fake.on('GET /v1/me/connections', CONNECTIONS);
        fake.on('GET /v1/users/caio.r', {
          status: 200,
          body: {
            handle: 'caio.r',
            name: 'Caio Ribeiro',
            bio: null,
            avatarUrl: null,
            accountType: 'personal',
            counts: { posts: 2, connections: 7, creators: 1 },
          },
        });
        fake.on('GET /v1/users/caio.r/posts', {
          status: 200,
          body: { items: [], nextCursor: null },
        });
        fake.on('DELETE /v1/connections/caio.r', { status: 204 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: /^@caio\.r, / }));
    await userEvent.press(
      await screen.findByRole('button', {
        name: 'Conectados com @caio.r, toque para ver as opções',
      }),
    );
    await userEvent.press(await screen.findByRole('button', { name: DISCONNECT_ACTION }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/perfil/conexoes');
    });
    expect(api.callsTo('DELETE /v1/connections/caio.r')).toHaveLength(1);
    // De volta à lista, a linha já saiu.
    await waitFor(() => {
      expect(screen.queryByText('caio.r')).not.toBeOnTheScreen();
    });
    expect(screen.getByText('bia.alves')).toBeOnTheScreen();
  });
});
