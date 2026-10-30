import { userEvent } from '@testing-library/react-native';
import { screen, waitFor, within } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { POST_UNAVAILABLE } from './PostDetailScreen';
import { personalMe } from '../../test-utils/fake-api';
import { AUTHORS, feedPage, photoPost, textPost, thread } from '../../test-utils/post-fixtures';
import { renderApp } from '../../test-utils/render-app';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('detalhe da publicação (ux.md §4.2)', () => {
  it('tocar no texto de um post abre o detalhe na aba Início, com os comentários abaixo', async () => {
    const post = textPost({ commentCount: 1 });
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([post]) });
        fake.on(`GET /v1/posts/${post.id}`, { status: 200, body: post });
        fake.on(`GET /v1/posts/${post.id}/comments`, {
          status: 200,
          body: { items: [thread({ body: 'Também tentei!' })], nextCursor: null },
        });
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Textos' }));
    await userEvent.press(await screen.findByLabelText(/^@juprado, Conexão/));
    await waitFor(() => {
      expect(screen).toHavePathname(`/pessoal/inicio/p/${post.id}`);
    });
    expect(screen.getByRole('header', { name: 'Publicação' })).toBeOnTheScreen();
    expect(await screen.findByText('Também tentei!')).toBeOnTheScreen();
    expect(screen.getByLabelText('Comentário')).toBeOnTheScreen();
    // A aba de origem continua ativa.
    expect(screen.getByRole('tab', { name: 'Início' })).toBeSelected();
  });

  it('404 (apagada, sem acesso ou inexistente): "Esta publicação não está mais disponível."', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil/p/01a189e0-af57-7000-8000-00000000ffff',
      configure: (fake) => {
        fake.on('GET /v1/posts/01a189e0-af57-7000-8000-00000000ffff', {
          status: 404,
          body: { code: 'NOT_FOUND', message: 'Not found' },
        });
      },
    });
    expect(await screen.findByRole('header', { name: POST_UNAVAILABLE })).toBeOnTheScreen();
  });

  it('2.9: apagar o próprio post no detalhe confirma, volta e tira o post do perfil', async () => {
    const own = photoPost({ isOwn: true, author: AUTHORS.helena });
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons?: AlertButton[]) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('GET /v1/users/helena/posts', {
          status: 200,
          body: { items: [own], nextCursor: null },
        });
        fake.on(`GET /v1/posts/${own.id}`, { status: 200, body: own });
        fake.on(`GET /v1/posts/${own.id}/comments`, {
          status: 200,
          body: { items: [], nextCursor: null },
        });
        fake.on(`DELETE /v1/posts/${own.id}`, { status: 204 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Publicação com 2 fotos' }));
    await waitFor(() => {
      expect(screen).toHavePathname(`/pessoal/perfil/p/${own.id}`);
    });
    const card = within(await screen.findByTestId(`post-${own.id}`));
    await userEvent.press(card.getByRole('button', { name: 'Mais opções' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/perfil');
    });
    expect(api.callsTo(`DELETE /v1/posts/${own.id}`)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Publicação com 2 fotos' })).not.toBeOnTheScreen();
  });
});
