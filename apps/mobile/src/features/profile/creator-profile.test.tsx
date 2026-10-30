import { userEvent } from '@testing-library/react-native';
import { screen, waitFor, within } from 'expo-router/testing-library';

import { creatorMe, personalMe } from '../../test-utils/fake-api';
import { creatorProfile, deferredReply } from '../../test-utils/relation-fixtures';
import { renderApp } from '../../test-utils/render-app';

afterEach(() => {
  jest.restoreAllMocks();
});

const EMPTY_POSTS = { status: 200, body: { items: [], nextCursor: null } };

describe('perfil de criador visto por pessoa (história 3.4, p17)', () => {
  it('3.4 CA1/CA2: publicações e seguidores (sem toque), nome, tipo, bio, Seguir e o menu ⋯, com Pesquisar ativa', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/pesquisar/u/trilhasdosul',
      configure: (fake) => {
        fake.on('GET /v1/users/trilhasdosul', { status: 200, body: creatorProfile() });
        fake.on('GET /v1/users/trilhasdosul/posts', EMPTY_POSTS);
      },
    });
    const header = within(await screen.findByTestId('profile-header'));
    expect(header.getByRole('header', { name: 'trilhasdosul' })).toBeOnTheScreen();
    expect(header.getByLabelText('5 publicações')).toBeOnTheScreen();
    expect(header.getByLabelText('8.903 seguidores')).toBeOnTheScreen();
    // Seguidores não têm lista para ninguém (ADR 0004, PERM-09).
    expect(header.queryByRole('button', { name: '8.903 seguidores' })).not.toBeOnTheScreen();
    expect(header.getByText('Rafael Duarte')).toBeOnTheScreen();
    expect(header.getByText('Criador de conteúdo · não segue ninguém')).toBeOnTheScreen();
    expect(header.getByText('Trilhas e acampamentos no Sul do Brasil.')).toBeOnTheScreen();
    expect(header.getByRole('button', { name: 'Seguir @trilhasdosul' })).toBeOnTheScreen();
    expect(header.getByRole('button', { name: 'Mais opções' })).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Pesquisar' })).toBeSelected();
  });

  it('3.3 CA1/CA6: Seguir e Seguindo no perfil, otimistas, com o estado que a API devolve', async () => {
    const put = deferredReply();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/inicio/u/trilhasdosul',
      configure: (fake) => {
        fake.on('GET /v1/users/trilhasdosul', { status: 200, body: creatorProfile() });
        fake.on('GET /v1/users/trilhasdosul/posts', EMPTY_POSTS);
        fake.on('PUT /v1/creators/trilhasdosul/follow', put.handler);
        fake.on('DELETE /v1/creators/trilhasdosul/follow', {
          status: 200,
          body: { following: false },
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Seguir @trilhasdosul' }));
    const following = 'Seguindo @trilhasdosul, toque para deixar de seguir';
    expect(screen.getByRole('button', { name: following })).toBeOnTheScreen();
    await put.resolve({ status: 200, body: { following: true } });
    expect(screen.getByRole('button', { name: following })).toBeOnTheScreen();
    // Seguidores com cache de 60 s no servidor: o número não muda na hora (CNT-02).
    expect(screen.getByLabelText('8.903 seguidores')).toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: following }));
    expect(screen.getByRole('button', { name: 'Seguir @trilhasdosul' })).toBeOnTheScreen();
    await waitFor(() => {
      expect(api.callsTo('DELETE /v1/creators/trilhasdosul/follow')).toHaveLength(1);
    });
    expect(screen.getByRole('tab', { name: 'Início' })).toBeSelected();
  });

  it('3.4 (ux.md §3.2): o mesmo perfil aberto pela aba Perfil mantém a aba Perfil ativa', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil/u/trilhasdosul',
      configure: (fake) => {
        fake.on('GET /v1/users/trilhasdosul', {
          status: 200,
          body: creatorProfile({ followedByMe: true }),
        });
        fake.on('GET /v1/users/trilhasdosul/posts', EMPTY_POSTS);
      },
    });
    expect(
      await screen.findByRole('button', {
        name: 'Seguindo @trilhasdosul, toque para deixar de seguir',
      }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Perfil' })).toBeSelected();
  });

  it('criador vendo outro criador: sem Seguir (criador não segue, PERM-01), com o menu ⋯', async () => {
    const { api } = await renderApp({
      signedInAs: creatorMe(),
      initialUrl: '/criador/perfil/u/trilhasdosul',
      configure: (fake) => {
        fake.on('GET /v1/users/trilhasdosul', { status: 200, body: creatorProfile() });
        fake.on('GET /v1/users/trilhasdosul/posts', EMPTY_POSTS);
      },
    });
    expect(await screen.findByRole('header', { name: 'trilhasdosul' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Seguir @trilhasdosul' })).not.toBeOnTheScreen();
    expect(screen.queryByText('Seguir')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Mais opções' })).toBeOnTheScreen();
    expect(api.callsTo('PUT /v1/creators/trilhasdosul/follow')).toHaveLength(0);
  });
});

describe('perfil próprio do criador (história 3.5, p19)', () => {
  it('3.5 CA1: "Editar perfil" e "Nova publicação"; seguidores não tocável; sem menu ⋯', async () => {
    await renderApp({ signedInAs: creatorMe() });
    const header = within(await screen.findByTestId('profile-header'));
    expect(header.getByRole('button', { name: 'Editar perfil' })).toBeOnTheScreen();
    expect(header.getByRole('button', { name: 'Nova publicação' })).toBeOnTheScreen();
    expect(header.getByLabelText('2.418 seguidores')).toBeOnTheScreen();
    expect(header.queryByRole('button', { name: '2.418 seguidores' })).not.toBeOnTheScreen();
    expect(header.queryByRole('button', { name: 'Mais opções' })).not.toBeOnTheScreen();
    await userEvent.press(header.getByRole('button', { name: 'Nova publicação' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/criar');
    });
  });
});
