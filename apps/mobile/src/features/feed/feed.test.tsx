import { feedWindowLabel } from '@sussurro/shared';
import { userEvent } from '@testing-library/react-native';
import { act, screen, waitFor, within } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { FEED_EMPTY_TITLE, FEED_ERROR_TITLE, LOAD_MORE_FAILED } from './FeedScreen';
import { NetworkError } from '../../lib/api/errors';
import { personalMe } from '../../test-utils/fake-api';
import { AUTHORS, feedPage, photoPost, textPost } from '../../test-utils/post-fixtures';
import { renderApp } from '../../test-utils/render-app';
import { POST_DELETED_MESSAGE } from '../posts/useDeletePost';
import { LIKE_ERROR_MESSAGE } from '../posts/useLike';

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * Chega ao fim da lista. No Jest o ScrollView é um dublê sem layout, então o `onEndReached` que o
 * FlatList recebe é chamado direto (é o que o VirtualizedList faz ao rolar até o fim).
 */
async function scrollToEnd(testID: string) {
  const list = screen.getByTestId(testID);
  await act(async () => {
    (list.props.onEndReached as (info: { distanceFromEnd: number }) => void)({
      distanceFromEnd: 0,
    });
    await Promise.resolve();
  });
}

describe('feed (história 2.5)', () => {
  it('FEED-14/FEED-04: no fim de cada aba aparece "Você está em dia" com o período de windowHours', async () => {
    const photo = photoPost();
    const text = textPost();
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', ({ query }) => ({
          status: 200,
          body:
            query.type === 'photo'
              ? feedPage([photo], { windowHours: 72 })
              : feedPage([text], { windowHours: 24 }),
        }));
      },
    });
    const photoEnd = await screen.findByTestId('caught-up-photo');
    expect(within(photoEnd).getByText('Você está em dia')).toBeOnTheScreen();
    expect(
      within(photoEnd).getByText(
        'Você viu todas as fotos dos últimos 3 dias de quem você conhece e segue.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByTestId(`post-${photo.id}`)).toBeOnTheScreen();

    await userEvent.press(screen.getByRole('tab', { name: 'Textos' }));
    const textEnd = await screen.findByTestId('caught-up-text');
    expect(within(textEnd).getByText(/todos os textos do último dia/)).toBeOnTheScreen();
    expect(screen.getByText(text.text ?? '')).toBeOnTheScreen();
    // A aba de fotos fica guardada (não recarrega ao voltar).
    expect(screen.queryByTestId('caught-up-photo')).not.toBeOnTheScreen();
  });

  it.each([
    [72, 'últimos 3 dias'],
    [24, 'último dia'],
    [36, 'últimas 36 horas'],
  ])(
    'FEED-04: windowHours %i → "%s" (feedWindowLabel de packages/shared)',
    async (hours, label) => {
      expect(feedWindowLabel(hours)).toBe(label);
      await renderApp({
        signedInAs: personalMe(),
        configure: (fake) => {
          fake.on('GET /v1/feed', { status: 200, body: feedPage([], { windowHours: hours }) });
        },
      });
      // Sem posts na janela (mas com conexões): só o "Você está em dia".
      const end = await screen.findByTestId('caught-up-photo');
      expect(within(end).getByText(new RegExp(label))).toBeOnTheScreen();
    },
  );

  it('FEED-14: sem conexões e sem criadores mostra o EmptyState "Seu início está vazio"', async () => {
    await renderApp({
      signedInAs: personalMe({ counts: { posts: 0, connections: 0, creators: 0 } }),
    });
    expect(await screen.findByRole('header', { name: FEED_EMPTY_TITLE })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Conectar ao vivo' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Pesquisar criadores' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/pesquisar');
    });
    // 3.9 (Fase 3b): a ação leva à busca de verdade, com a aba Pesquisar ativa.
    expect(await screen.findByLabelText('Pesquisar @criador')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Pesquisar' })).toBeSelected();
  });

  it('FEED-06/FEED-14: falha na página 2 mantém a página 1 e mostra "Não carregou. Tentar de novo"', async () => {
    const first = [photoPost(), photoPost()];
    const second = [photoPost()];
    let failSecond = true;
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', ({ query }) => {
          if (query.cursor === undefined) {
            return {
              status: 200,
              body: feedPage(first, { nextCursor: 'c2', caughtUp: false }),
            };
          }
          if (failSecond) throw new NetworkError();
          return { status: 200, body: feedPage(second) };
        });
      },
    });
    await screen.findByTestId(`post-${first[1]!.id}`);
    expect(screen.queryByTestId('caught-up-photo')).not.toBeOnTheScreen();

    await scrollToEnd('feed-list-photo');
    expect(await screen.findByText(LOAD_MORE_FAILED)).toBeOnTheScreen();
    // A página 1 continua na tela.
    expect(screen.getByTestId(`post-${first[0]!.id}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`post-${first[1]!.id}`)).toBeOnTheScreen();

    failSecond = false;
    await userEvent.press(
      within(screen.getByTestId('feed-more-failed-photo')).getByRole('button', {
        name: 'Tentar de novo',
      }),
    );
    expect(await screen.findByTestId(`post-${second[0]!.id}`)).toBeOnTheScreen();
    expect(screen.getByTestId('caught-up-photo')).toBeOnTheScreen();
    const cursors = api.callsTo('GET /v1/feed').map((call) => call.query.cursor);
    expect(cursors).toEqual([undefined, 'c2', 'c2']);
    expect(api.callsTo('GET /v1/feed')[0]?.query).toMatchObject({ type: 'photo', limit: '20' });
  });

  it('FEED-08: cursor recusado (400 em `cursor`) recomeça da primeira página', async () => {
    const first = [photoPost()];
    let calls = 0;
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', ({ query }) => {
          calls += 1;
          if (query.cursor !== undefined) {
            return {
              status: 400,
              body: {
                code: 'VALIDATION_ERROR',
                message: 'Invalid cursor',
                details: [{ path: 'cursor', message: 'Cursor inválido.' }],
              },
            };
          }
          return {
            status: 200,
            body: feedPage(first, { nextCursor: calls === 1 ? 'velho' : null }),
          };
        });
      },
    });
    await screen.findByTestId(`post-${first[0]!.id}`);
    await scrollToEnd('feed-list-photo');
    await screen.findByTestId('caught-up-photo');
    expect(api.callsTo('GET /v1/feed').map((call) => call.query.cursor)).toEqual([
      undefined,
      'velho',
      undefined,
    ]);
    expect(screen.queryByText(LOAD_MORE_FAILED)).not.toBeOnTheScreen();
  });

  it('primeira página que falha: EmptyState "Não foi possível carregar" com "Tentar de novo"', async () => {
    let fail = true;
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', () =>
          fail
            ? { status: 500, body: { code: 'INTERNAL_ERROR', message: 'boom' } }
            : { status: 200, body: feedPage([photoPost()]) },
        );
      },
    });
    expect(await screen.findByRole('header', { name: FEED_ERROR_TITLE })).toBeOnTheScreen();
    expect(screen.getByText('Algo deu errado do nosso lado. Tente de novo.')).toBeOnTheScreen();
    fail = false;
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByTestId('caught-up-photo')).toBeOnTheScreen();
  });

  it('puxar para atualizar busca a primeira página de novo', async () => {
    const before = photoPost();
    const after = photoPost();
    let calls = 0;
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', () => {
          calls += 1;
          return { status: 200, body: feedPage(calls === 1 ? [before] : [after, before]) };
        });
      },
    });
    await screen.findByTestId(`post-${before.id}`);
    const list = screen.getByTestId('feed-list-photo');
    await act(async () => {
      (list.props.refreshControl as { props: { onRefresh: () => void } }).props.onRefresh();
      await Promise.resolve();
    });
    expect(await screen.findByTestId(`post-${after.id}`)).toBeOnTheScreen();
  });

  it('2.10: o post de foto no feed tem "Conexão"/"Criador", "N curtidas" e "Ver todos os N comentários"', async () => {
    const fromConnection = photoPost({ likeCount: 1, commentCount: 1 });
    const fromCreator = photoPost({ author: AUTHORS.cozinhadabia, likeCount: 6, commentCount: 2 });
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([fromConnection, fromCreator]) });
      },
    });
    const first = within(await screen.findByTestId(`post-${fromConnection.id}`));
    expect(first.getByText('Conexão')).toBeOnTheScreen();
    expect(first.getByText('1 curtida')).toBeOnTheScreen();
    expect(first.getByText('Ver 1 comentário')).toBeOnTheScreen();
    expect(first.getByTestId(`post-${fromConnection.id}-counter`)).toHaveTextContent('1/2');
    const second = within(screen.getByTestId(`post-${fromCreator.id}`));
    expect(second.getByText('Criador')).toBeOnTheScreen();
    expect(second.getByText('6 curtidas')).toBeOnTheScreen();
    expect(second.getByText('Ver todos os 2 comentários')).toBeOnTheScreen();
  });

  it('FEED-05 (reel): a aba Reels pede type=reel e termina em "Você está em dia"; o coração segue como tela futura (Fase 6)', async () => {
    const { api } = await renderApp({ signedInAs: personalMe() });
    await screen.findByTestId('caught-up-photo');
    await userEvent.press(screen.getByRole('tab', { name: 'Reels' }));
    expect(await screen.findByTestId('caught-up-reel')).toBeOnTheScreen();
    expect(screen.getByText(/todos os reels dos últimos 3 dias/)).toBeOnTheScreen();
    expect(api.callsTo('GET /v1/feed').map((call) => call.query.type)).toContain('reel');
    await userEvent.press(screen.getByRole('button', { name: 'Notificações' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio/notificacoes');
    });
    expect(screen.getByTestId('tela-notificacoes-pessoal')).toBeOnTheScreen();
  });
});

describe('curtir (história 2.7)', () => {
  it('2.7 CA1: curtida otimista; a resposta da API acerta o número', async () => {
    const post = photoPost({ likeCount: 6, likedByMe: false });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([post]) });
        fake.on(`PUT /v1/posts/${post.id}/like`, {
          status: 200,
          body: { likeCount: 9, likedByMe: true },
        });
      },
    });
    const card = within(await screen.findByTestId(`post-${post.id}`));
    await userEvent.press(card.getByRole('button', { name: 'Curtir' }));
    expect(card.getByRole('button', { name: 'Curtido' })).toBeSelected();
    expect(await card.findByText('9 curtidas')).toBeOnTheScreen();
    expect(api.callsTo(`PUT /v1/posts/${post.id}/like`)).toHaveLength(1);
  });

  it('2.7 CA5: falha de rede volta o coração e mostra "Não foi possível curtir."', async () => {
    const post = textPost({ likeCount: 4, likedByMe: false });
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([post]) });
        fake.on(`PUT /v1/posts/${post.id}/like`, () => {
          throw new NetworkError();
        });
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Textos' }));
    const card = within(await screen.findByTestId(`post-${post.id}`));
    await userEvent.press(card.getByRole('button', { name: 'Curtir' }));
    expect(await screen.findByText(LIKE_ERROR_MESSAGE)).toBeOnTheScreen();
    expect(card.getByRole('button', { name: 'Curtir' })).not.toBeSelected();
    expect(card.getByTestId(`post-${post.id}-likes`)).toHaveTextContent('4');
  });

  it('2.7 CA5: erro do servidor ao descurtir também volta ao estado anterior', async () => {
    const post = photoPost({ likeCount: 3, likedByMe: true });
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([post]) });
        fake.on(`DELETE /v1/posts/${post.id}/like`, {
          status: 503,
          body: { code: 'SERVICE_UNAVAILABLE', message: 'down' },
        });
      },
    });
    const card = within(await screen.findByTestId(`post-${post.id}`));
    await userEvent.press(card.getByRole('button', { name: 'Curtido' }));
    expect(await screen.findByText(LIKE_ERROR_MESSAGE)).toBeOnTheScreen();
    expect(card.getByRole('button', { name: 'Curtido' })).toBeSelected();
    expect(card.getByText('3 curtidas')).toBeOnTheScreen();
  });
});

describe('apagar publicação (história 2.9)', () => {
  it('2.9 CA1: o próprio post tem "Mais opções" → confirmação → some do feed na hora', async () => {
    const own = textPost({ isOwn: true, author: AUTHORS.helena, text: 'Meu texto' });
    const other = textPost();
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_t, _m, buttons?: AlertButton[]) => {
        buttons?.find((button) => button.style === 'destructive')?.onPress?.();
      });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([own, other]) });
        fake.on(`DELETE /v1/posts/${own.id}`, { status: 204 });
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Textos' }));
    await screen.findByTestId(`post-${own.id}`);
    // Fase 3b (D-UX14): o post de outra conta também tem o menu, mas sem "Excluir".
    await userEvent.press(
      within(screen.getByTestId(`post-${other.id}`)).getByRole('button', { name: 'Mais opções' }),
    );
    expect(screen.getByRole('button', { name: 'Denunciar' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Excluir' })).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Cancelar' }));
    expect(alert).not.toHaveBeenCalled();
    await userEvent.press(
      within(screen.getByTestId(`post-${own.id}`)).getByRole('button', { name: 'Mais opções' }),
    );
    expect(alert).toHaveBeenCalledWith(
      'Excluir publicação?',
      'Não dá para desfazer.',
      expect.any(Array),
    );
    await waitFor(() => {
      expect(screen.queryByTestId(`post-${own.id}`)).not.toBeOnTheScreen();
    });
    expect(api.callsTo(`DELETE /v1/posts/${own.id}`)).toHaveLength(1);
    expect(await screen.findByText(POST_DELETED_MESSAGE)).toBeOnTheScreen();
    expect(screen.getByTestId(`post-${other.id}`)).toBeOnTheScreen();
  });
});
