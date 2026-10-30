import { userEvent } from '@testing-library/react-native';
import { screen, waitFor, within } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { OWN_LIST_NOTE } from './OwnListScreen';
import { NetworkError } from '../../lib/api/errors';
import { personalMe } from '../../test-utils/fake-api';
import { ownListItem, scrollListToEnd } from '../../test-utils/relation-fixtures';
import { renderApp } from '../../test-utils/render-app';
import { UNFOLLOW_ERROR_MESSAGE } from '../relations/useFollowToggle';

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

const EMPTY_PAGE = { status: 200, body: { items: [], nextCursor: null } };

describe('listas próprias (história 3.6)', () => {
  it('3.6 CA1: "conexões" no próprio perfil abre a lista com "Só você vê esta lista." e paginação', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('GET /v1/me/connections', ({ query }) =>
          query.cursor === undefined
            ? {
                status: 200,
                body: { items: [ownListItem()], nextCursor: 'c2' },
              }
            : {
                status: 200,
                body: {
                  items: [ownListItem({ handle: 'bia.alves', name: 'Bia Alves' })],
                  nextCursor: null,
                },
              },
        );
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: '4 conexões' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/perfil/conexoes');
    });
    expect(await screen.findByText('caio.r')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Conexões' })).toBeOnTheScreen();
    expect(screen.getByText(OWN_LIST_NOTE)).toBeOnTheScreen();
    expect(screen.getByText('Caio Ribeiro · desde 27 out')).toBeOnTheScreen();
    // Lista própria: só cursor e limit vão na query (PERM-08).
    expect(api.callsTo('GET /v1/me/connections')[0]?.query).toEqual({ limit: '20' });

    await scrollListToEnd(screen.getByTestId('tela-conexoes-lista'));
    expect(await screen.findByText('bia.alves')).toBeOnTheScreen();
    expect(api.callsTo('GET /v1/me/connections')[1]?.query).toEqual({ cursor: 'c2', limit: '20' });
    // A aba Perfil continua ativa.
    expect(screen.getByRole('tab', { name: 'Perfil' })).toBeSelected();
  });

  it('3.6: conexões vazia mostra o EmptyState com "Conectar ao vivo" (aba Conectar, Fase 4)', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil/conexoes',
      configure: (fake) => {
        fake.on('GET /v1/me/connections', EMPTY_PAGE);
      },
    });
    expect(await screen.findByRole('header', { name: 'Nenhuma conexão ainda' })).toBeOnTheScreen();
    expect(screen.getByText(OWN_LIST_NOTE)).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Conectar ao vivo' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/conectar');
    });
  });

  it('3.6: erro na primeira página mostra "Tentar de novo"', async () => {
    let fail = true;
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil/seguindo',
      configure: (fake) => {
        fake.on('GET /v1/me/following', () => {
          if (fail) throw new NetworkError();
          return { status: 200, body: { items: [ownListItem()], nextCursor: null } };
        });
      },
    });
    const error = await screen.findByTestId('tela-seguindo-erro');
    fail = false;
    await userEvent.press(within(error).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('caio.r')).toBeOnTheScreen();
  });

  it('3.6 + 3.3: "criadores" abre "Criadores que sigo"; (Seguindo) pede confirmação e a linha some na hora', async () => {
    const alert = answerAlerts('Deixar de seguir');
    const creator = ownListItem({ handle: 'trilhasdosul', name: 'Rafael Duarte' });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('GET /v1/me/following', {
          status: 200,
          body: {
            items: [creator, ownListItem({ handle: 'estudioaurora', name: 'Estúdio Aurora' })],
            nextCursor: null,
          },
        });
        fake.on('DELETE /v1/creators/trilhasdosul/follow', {
          status: 200,
          body: { following: false },
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: '3 criadores' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/perfil/seguindo');
    });
    expect(await screen.findByText('trilhasdosul')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Criadores que sigo' })).toBeOnTheScreen();
    expect(screen.getByText(OWN_LIST_NOTE)).toBeOnTheScreen();

    await userEvent.press(
      screen.getByRole('button', { name: 'Seguindo @trilhasdosul, toque para deixar de seguir' }),
    );
    expect(alert).toHaveBeenCalledWith(
      'Deixar de seguir @trilhasdosul?',
      expect.any(String),
      expect.any(Array),
    );
    await waitFor(() => {
      expect(screen.queryByText('trilhasdosul')).not.toBeOnTheScreen();
    });
    expect(screen.getByText('estudioaurora')).toBeOnTheScreen();
    expect(api.callsTo('DELETE /v1/creators/trilhasdosul/follow')).toHaveLength(1);
  });

  it('3.3 CA6: deixar de seguir pela lista falhou → a linha volta e aparece o Toast', async () => {
    answerAlerts('Deixar de seguir');
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil/seguindo',
      configure: (fake) => {
        fake.on('GET /v1/me/following', {
          status: 200,
          body: { items: [ownListItem({ handle: 'trilhasdosul' })], nextCursor: null },
        });
        fake.on('DELETE /v1/creators/trilhasdosul/follow', () => {
          throw new NetworkError();
        });
      },
    });
    await userEvent.press(
      await screen.findByRole('button', {
        name: 'Seguindo @trilhasdosul, toque para deixar de seguir',
      }),
    );
    expect(await screen.findByText(UNFOLLOW_ERROR_MESSAGE)).toBeOnTheScreen();
    expect(screen.getByText('trilhasdosul')).toBeOnTheScreen();
  });

  it('3.6: "Criadores que sigo" vazia leva a "Pesquisar criadores"', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil/seguindo',
      configure: (fake) => {
        fake.on('GET /v1/me/following', EMPTY_PAGE);
      },
    });
    expect(
      await screen.findByRole('header', { name: 'Você ainda não segue criadores' }),
    ).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Pesquisar criadores' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/pesquisar');
    });
    expect(screen.getByRole('tab', { name: 'Pesquisar' })).toBeSelected();
  });
});
