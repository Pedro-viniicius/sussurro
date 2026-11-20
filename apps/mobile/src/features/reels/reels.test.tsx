import { fireEvent, userEvent } from '@testing-library/react-native';
import { act, screen, waitFor, within } from 'expo-router/testing-library';
import { Alert, type AlertButton, AppState, type AppStateStatus } from 'react-native';

import { FAILED_REEL_TITLE } from './ReelGridTile';
import {
  creatorMe,
  type FakeApi,
  type FakeReply,
  personalMe,
  session,
} from '../../test-utils/fake-api';
import {
  AUTHORS,
  feedPage,
  pendingVideo,
  reelPost,
  videoMedia,
} from '../../test-utils/post-fixtures';
import { deferredReply } from '../../test-utils/relation-fixtures';
import { renderApp } from '../../test-utils/render-app';
import { fakeVideo } from '../../test-utils/video-mock';
import { PUBLISHED_MESSAGE } from '../create/PublishingProvider';

afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  fakeVideo.reset();
});

/** Feed com estes reels na aba Reels (as outras abas vazias). */
function reelFeed(fake: FakeApi, reels: ReturnType<typeof reelPost>[]) {
  fake.on('GET /v1/feed', ({ query }) => ({
    status: 200,
    body: feedPage(query.type === 'reel' ? reels : []),
  }));
  for (const reel of reels) {
    fake.on(`GET /v1/posts/${reel.id}`, { status: 200, body: reel });
  }
}

async function openReelsTab() {
  await screen.findByTestId('caught-up-photo');
  await userEvent.press(screen.getByRole('tab', { name: 'Reels' }));
}

/** Responde ao Alert apertando o botão com este texto. */
function answerAlerts(...texts: string[]) {
  return jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      buttons
        ?.find((button) => button.text !== undefined && texts.includes(button.text))
        ?.onPress?.();
    });
}

describe('grade de reels (história 5.4, p08)', () => {
  it('5.4 CA1/FEED-05: a aba Reels do feed mostra a grade 3 colunas 9:16 com a duração sobre a miniatura', async () => {
    const first = reelPost({ media: [videoMedia({ durationS: 42 })] });
    const second = reelPost({
      author: AUTHORS.cozinhadabia,
      media: [videoMedia({ durationS: 75.4 })],
    });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        reelFeed(fake, [first, second]);
      },
    });
    await openReelsTab();
    const tile = await screen.findByRole('button', { name: 'Reel de @marinac, 42 segundos' });
    expect(within(tile).getByText('0:42')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Reel de @cozinhadabia, 1 minuto e 15 segundos' }),
    ).toBeOnTheScreen();
    expect(screen.getByText('1:15')).toBeOnTheScreen();
    // 9:16 e 3 colunas (largura da tela menos os dois vãos de 2, dividida por 3).
    const { width, height } = (tile.props as { style: { width: number; height: number }[] })
      .style[0] as { width: number; height: number };
    expect(height).toBe(Math.round((width * 16) / 9));
    expect(width).toBeCloseTo((750 - 4) / 3, 1);
    // A miniatura é o poster; a chave do cache é o id da mídia.
    expect(screen.getByTestId(`post-image-${first.media[0]?.id ?? ''}-img`)).toBeOnTheScreen();
    expect(screen.getByTestId('caught-up-reel')).toBeOnTheScreen();
    expect(api.callsTo('GET /v1/feed').some((call) => call.query.type === 'reel')).toBe(true);
  });

  it('MID-09/5.3 CA3: reel em processamento ou com falha nunca aparece no feed, nem o do próprio autor (defesa no app)', async () => {
    const published = reelPost();
    const processing = reelPost({
      status: 'processing',
      publishedAt: null,
      media: [pendingVideo()],
    });
    const failed = reelPost({
      status: 'failed',
      publishedAt: null,
      media: [pendingVideo('failed')],
    });
    const ownProcessing = reelPost({
      isOwn: true,
      author: AUTHORS.helena,
      status: 'processing',
      publishedAt: null,
      media: [pendingVideo()],
    });
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        reelFeed(fake, [processing, published, failed, ownProcessing]);
      },
    });
    await openReelsTab();
    expect(await screen.findByTestId(`reel-${published.id}`)).toBeOnTheScreen();
    for (const hidden of [processing, failed, ownProcessing]) {
      expect(screen.queryByTestId(`reel-${hidden.id}`)).not.toBeOnTheScreen();
    }
    expect(screen.queryByText('Processando')).not.toBeOnTheScreen();
    expect(screen.queryByText('Falhou')).not.toBeOnTheScreen();
  });

  it('MID-09: no perfil de outra conta só aparece o reel publicado', async () => {
    const theirs = reelPost();
    const theirsProcessing = reelPost({
      status: 'processing',
      publishedAt: null,
      media: [pendingVideo()],
    });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/inicio/u/marinac',
      configure: (fake) => {
        fake.on('GET /v1/users/marinac', {
          status: 200,
          body: {
            handle: 'marinac',
            name: 'Marina Costa',
            bio: null,
            avatarUrl: null,
            accountType: 'personal',
            counts: { posts: 1, connections: 1, creators: 0 },
          },
        });
        fake.on('GET /v1/users/marinac/posts', ({ query }) => ({
          status: 200,
          body: {
            items: query.type === 'reel' ? [theirsProcessing, theirs] : [],
            nextCursor: null,
          },
        }));
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Reels' }));
    expect(await screen.findByTestId(`reel-${theirs.id}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`reel-${theirsProcessing.id}`)).not.toBeOnTheScreen();
    expect(screen.queryByText('Processando')).not.toBeOnTheScreen();
  });

  it('MID-09/5.6: no próprio perfil o dono vê também "Processando" (sem toque) e "Falhou"', async () => {
    const mine = reelPost({ isOwn: true, author: AUTHORS.helena });
    const mineProcessing = reelPost({
      isOwn: true,
      author: AUTHORS.helena,
      status: 'processing',
      publishedAt: null,
      media: [pendingVideo()],
    });
    const mineFailed = reelPost({
      isOwn: true,
      author: AUTHORS.helena,
      status: 'failed',
      publishedAt: null,
      media: [pendingVideo('failed')],
    });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('GET /v1/users/helena/posts', ({ query }) => ({
          status: 200,
          body: {
            items: query.type === 'reel' ? [mineProcessing, mineFailed, mine] : [],
            nextCursor: null,
          },
        }));
        // O tile "Processando" de outra sessão consulta sozinho (ux.md §12.3): continua processando.
        fake.on(`GET /v1/posts/${mineProcessing.id}`, { status: 200, body: mineProcessing });
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Reels' }));
    expect(await screen.findByRole('button', { name: 'Reel processando' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reel não publicado' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Reel de @helena, 42 segundos' })).toBeOnTheScreen();
  });
});

describe('visualizador de reels (história 5.5)', () => {
  it('5.5 CA1: o tile abre só aquele reel, que toca sozinho; ao terminar, "Assistir de novo" e nenhum outro abre', async () => {
    const first = reelPost({ caption: 'Fim de tarde no Passaúna.' });
    const second = reelPost({ author: AUTHORS.cozinhadabia });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        reelFeed(fake, [first, second]);
      },
    });
    await openReelsTab();
    await userEvent.press(await screen.findByTestId(`reel-${first.id}`));
    await waitFor(() => {
      expect(screen).toHavePathname(`/reel/${first.id}`);
    });
    expect(await screen.findByRole('button', { name: 'Reel de @marinac' })).toBeOnTheScreen();
    expect(screen.getByText('marinac · Conexão')).toBeOnTheScreen();
    expect(screen.getByText('Fim de tarde no Passaúna.')).toBeOnTheScreen();
    // Um player só, com o MP4 deste reel, tocando.
    expect(fakeVideo.players).toHaveLength(1);
    const player = fakeVideo.last();
    expect(player.source).toEqual({ uri: first.media[0]?.url });
    expect(player.calls).toContain('play');
    expect(player.loop).toBe(false);

    const before = player.calls.length;
    await act(() => {
      player.finish();
    });
    expect(screen.getByRole('button', { name: 'Assistir de novo' })).toBeOnTheScreen();
    // Nada avança: a rota é a mesma, nenhum player novo, o outro reel nem é pedido à API.
    expect(screen).toHavePathname(`/reel/${first.id}`);
    expect(fakeVideo.players).toHaveLength(1);
    expect(player.calls.slice(before)).not.toContain('play');
    expect(api.callsTo(`GET /v1/posts/${second.id}`)).toHaveLength(0);

    await userEvent.press(screen.getByRole('button', { name: 'Assistir de novo' }));
    expect(player.calls.slice(before)).toEqual(expect.arrayContaining(['replay', 'play']));

    // ✕ volta à grade.
    await userEvent.press(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
  });

  it('curtir no visualizador; comentar abre a folha e pausa o vídeo por baixo', async () => {
    const reel = reelPost({ likeCount: 3, commentCount: 1 });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/reel/${reel.id}?origem=%2Fpessoal%2Finicio`,
      configure: (fake) => {
        reelFeed(fake, [reel]);
        fake.on(`PUT /v1/posts/${reel.id}/like`, {
          status: 200,
          body: { likeCount: 4, likedByMe: true },
        });
        fake.on(`GET /v1/posts/${reel.id}/comments`, {
          status: 200,
          body: { items: [], nextCursor: null },
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Curtir' }));
    expect(await screen.findByRole('button', { name: 'Curtido' })).toBeOnTheScreen();
    expect(screen.getByLabelText('4 curtidas')).toBeOnTheScreen();
    expect(api.callsTo(`PUT /v1/posts/${reel.id}/like`)).toHaveLength(1);

    const player = fakeVideo.last();
    await userEvent.press(screen.getByRole('button', { name: 'Comentar, 1 comentário' }));
    await waitFor(() => {
      expect(screen).toHavePathname(`/comentarios/${reel.id}`);
    });
    await waitFor(() => {
      expect(player.calls.at(-1)).toBe('pause');
    });
  });

  it('A-06: o criador não curte reels (só vê o número)', async () => {
    const reel = reelPost({ author: AUTHORS.cozinhadabia, likeCount: 12 });
    await renderApp({
      signedInAs: creatorMe(),
      initialUrl: `/reel/${reel.id}`,
      configure: (fake) => {
        reelFeed(fake, [reel]);
      },
    });
    expect(await screen.findByLabelText('12 curtidas')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Curtir' })).not.toBeOnTheScreen();
  });

  it('D-UX14/X.1: ⋯ num reel de outra conta tem "Denunciar" e "Bloquear"; denunciar leva à denúncia do post', async () => {
    const reel = reelPost();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/reel/${reel.id}`,
      configure: (fake) => {
        reelFeed(fake, [reel]);
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções' }));
    const menu = within(screen.getByTestId('moderation-menu'));
    expect(
      menu.getAllByRole('button').map((node) => String(node.props.accessibilityLabel)),
    ).toEqual(['Denunciar', 'Bloquear', 'Cancelar']);
    await userEvent.press(menu.getByRole('button', { name: 'Denunciar' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/denunciar');
    });
    expect(screen).toHaveSearchParams({ alvo: 'publicacao', id: reel.id });
  });

  it('X.2: bloquear pelo ⋯ do reel fecha o visualizador e o reel some da grade', async () => {
    const reel = reelPost();
    answerAlerts('Bloquear');
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        reelFeed(fake, [reel]);
        fake.on('POST /v1/me/blocks', { status: 204 });
      },
    });
    await openReelsTab();
    await userEvent.press(await screen.findByTestId(`reel-${reel.id}`));
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções' }));
    await userEvent.press(
      within(screen.getByTestId('moderation-menu')).getByRole('button', { name: 'Bloquear' }),
    );
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    expect(api.callsTo('POST /v1/me/blocks')[0]?.body).toEqual({ handle: 'marinac' });
    await waitFor(() => {
      expect(screen.queryByTestId(`reel-${reel.id}`)).not.toBeOnTheScreen();
    });
  });

  it('2.9: ⋯ no próprio reel exclui (com confirmação) e fecha o visualizador', async () => {
    const reel = reelPost({ isOwn: true, author: AUTHORS.helena });
    answerAlerts('Excluir');
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        reelFeed(fake, [reel]);
        fake.on(`DELETE /v1/posts/${reel.id}`, { status: 204 });
      },
    });
    await openReelsTab();
    await userEvent.press(await screen.findByTestId(`reel-${reel.id}`));
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções' }));
    await waitFor(() => {
      expect(api.callsTo(`DELETE /v1/posts/${reel.id}`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    expect(screen.queryByTestId(`reel-${reel.id}`)).not.toBeOnTheScreen();
  });

  it('MID-09: reel de outra conta que não está publicado (ou 404) → "Esta publicação não está mais disponível."', async () => {
    const processing = reelPost({
      status: 'processing',
      publishedAt: null,
      media: [pendingVideo()],
    });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/reel/${processing.id}`,
      configure: (fake) => {
        fake.on(`GET /v1/posts/${processing.id}`, { status: 200, body: processing });
      },
    });
    expect(
      await screen.findByRole('header', { name: 'Esta publicação não está mais disponível.' }),
    ).toBeOnTheScreen();
    expect(fakeVideo.players).toHaveLength(0);
  });

  it('o autor que abre o próprio reel em processamento vê "Seu reel está sendo processado…"', async () => {
    const mine = reelPost({
      isOwn: true,
      author: AUTHORS.helena,
      status: 'processing',
      publishedAt: null,
      media: [pendingVideo()],
    });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/reel/${mine.id}`,
      configure: (fake) => {
        fake.on(`GET /v1/posts/${mine.id}`, { status: 200, body: mine });
      },
    });
    expect(
      await screen.findByText('Seu reel está sendo processado. Isso leva alguns minutos.'),
    ).toBeOnTheScreen();
    expect(fakeVideo.players).toHaveLength(0);
  });

  it('erro de reprodução: "Tentar de novo" busca o post de novo (URL assinada nova) e recria o player', async () => {
    const reel = reelPost();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/reel/${reel.id}`,
      configure: (fake) => {
        reelFeed(fake, [reel]);
      },
    });
    await screen.findByRole('button', { name: 'Reel de @marinac' });
    await act(() => {
      fakeVideo.last().setStatus('error');
    });
    expect(screen.getByText('Não foi possível reproduzir este reel.')).toBeOnTheScreen();
    const gets = api.callsTo(`GET /v1/posts/${reel.id}`).length;
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => {
      expect(api.callsTo(`GET /v1/posts/${reel.id}`).length).toBeGreaterThan(gets);
    });
    expect(fakeVideo.players.length).toBeGreaterThanOrEqual(2);
  });
});

describe('o tile "Processando" de um reel de outra sessão (ux.md §12.3)', () => {
  const SECOND = 10_000;

  function processingReel() {
    return reelPost({
      isOwn: true,
      author: AUTHORS.helena,
      status: 'processing',
      publishedAt: null,
      media: [pendingVideo()],
    });
  }

  function publishedOf(reel: ReturnType<typeof reelPost>) {
    return {
      ...reel,
      status: 'published' as const,
      publishedAt: reel.createdAt,
      media: [videoMedia()],
    };
  }

  /** O perfil próprio com estes reels; `poll` responde a cada consulta do reel. */
  async function openOwnReels(
    reel: ReturnType<typeof reelPost>,
    poll: () => FakeReply | Promise<FakeReply>,
    extra?: (fake: FakeApi) => void,
  ) {
    const rendered = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('GET /v1/users/helena/posts', ({ query }) => ({
          status: 200,
          body: { items: query.type === 'reel' ? [reel] : [], nextCursor: null },
        }));
        fake.on(`GET /v1/posts/${reel.id}`, poll);
        extra?.(fake);
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Reels' }));
    return rendered;
  }

  async function advance(ms: number) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  /** Captura os ouvintes do AppState para o teste mandar o app ao segundo plano e de volta. */
  function captureAppState() {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'change') listeners.push(listener);
      return { remove: () => undefined };
    });
    return async (state: AppStateStatus) => {
      await act(async () => {
        for (const listener of listeners) listener(state);
        await Promise.resolve();
      });
    };
  }

  it('MID-16 (ux.md §12.3, c): consulta na hora e a cada 10 s; o published troca o tile no lugar, com "Publicado.", e a consulta para', async () => {
    const reel = processingReel();
    let polls = 0;
    const { api } = await openOwnReels(reel, () => {
      polls += 1;
      return { status: 200, body: polls < 3 ? reel : publishedOf(reel) };
    });
    const key = `GET /v1/posts/${reel.id}`;
    await waitFor(() => {
      expect(api.callsTo(key)).toHaveLength(1);
    });
    await advance(SECOND - 100);
    expect(api.callsTo(key)).toHaveLength(1);
    await advance(100);
    expect(api.callsTo(key)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Reel processando' })).toBeOnTheScreen();

    await advance(SECOND);
    expect(api.callsTo(key)).toHaveLength(3);
    expect(
      await screen.findByRole('button', { name: 'Reel de @helena, 42 segundos' }),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Reel processando' })).toBeNull();
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();

    await advance(3 * SECOND);
    expect(api.callsTo(key)).toHaveLength(3);
  });

  it('MID-17 (ux.md §12.3, c): o failed vira "Falhou" com o Toast "Não foi possível publicar este reel."', async () => {
    const reel = processingReel();
    await openOwnReels(reel, () => ({
      status: 200,
      body: { ...reel, status: 'failed', media: [pendingVideo('failed')] },
    }));
    expect(await screen.findByRole('button', { name: 'Reel não publicado' })).toBeOnTheScreen();
    expect(await screen.findByText(FAILED_REEL_TITLE)).toBeOnTheScreen();
  });

  it('MID-18 (ux.md §12.3, c): o 404 (apagado em outro celular) tira o tile, sem Toast, e a consulta para', async () => {
    const reel = processingReel();
    const { api } = await openOwnReels(reel, () => ({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'Não encontrado.' },
    }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Reel processando' })).toBeNull();
    });
    expect(screen.queryByText(PUBLISHED_MESSAGE)).toBeNull();
    expect(screen.queryByText(FAILED_REEL_TITLE)).toBeNull();
    await advance(3 * SECOND);
    expect(api.callsTo(`GET /v1/posts/${reel.id}`)).toHaveLength(1);
  });

  it('MID-19 (ux.md §12.3, c): 5 falhas seguidas param a consulta, sem Toast e com o tile no lugar', async () => {
    const reel = processingReel();
    const { api } = await openOwnReels(reel, () => ({
      status: 503,
      body: { code: 'SERVICE_UNAVAILABLE', message: 'Indisponível.' },
    }));
    const key = `GET /v1/posts/${reel.id}`;
    await waitFor(() => {
      expect(api.callsTo(key)).toHaveLength(1);
    });
    await advance(4 * SECOND);
    expect(api.callsTo(key)).toHaveLength(5);
    await advance(3 * SECOND);
    expect(api.callsTo(key)).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Reel processando' })).toBeOnTheScreen();
    expect(screen.queryByText(FAILED_REEL_TITLE)).toBeNull();

    // Até a próxima vez que a aba ficar visível: volta a consultar na hora.
    await userEvent.press(screen.getByRole('tab', { name: 'Fotos' }));
    await userEvent.press(screen.getByRole('tab', { name: 'Reels' }));
    await waitFor(() => {
      expect(api.callsTo(key)).toHaveLength(6);
    });
  });

  it('MID-20 (ux.md §12.3, c): para ao trocar de aba, ao sair da tela e no segundo plano; volta com a consulta na hora', async () => {
    const setAppState = captureAppState();
    const reel = processingReel();
    const { api } = await openOwnReels(
      reel,
      () => ({ status: 200, body: reel }),
      (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([]) });
      },
    );
    const key = `GET /v1/posts/${reel.id}`;
    await waitFor(() => {
      expect(api.callsTo(key)).toHaveLength(1);
    });

    // Outra aba do perfil: nenhuma consulta; de volta a Reels, na hora.
    await userEvent.press(screen.getByRole('tab', { name: 'Fotos' }));
    await advance(3 * SECOND);
    expect(api.callsTo(key)).toHaveLength(1);
    await userEvent.press(screen.getByRole('tab', { name: 'Reels' }));
    await waitFor(() => {
      expect(api.callsTo(key)).toHaveLength(2);
    });

    // Outra tela (a aba Início): nenhuma consulta; de volta ao Perfil, na hora.
    await userEvent.press(screen.getByRole('tab', { name: 'Início' }));
    await advance(3 * SECOND);
    expect(api.callsTo(key)).toHaveLength(2);
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    await waitFor(() => {
      expect(api.callsTo(key)).toHaveLength(3);
    });

    // Segundo plano: nenhuma consulta; de volta, na hora.
    await setAppState('background');
    await advance(3 * SECOND);
    expect(api.callsTo(key)).toHaveLength(3);
    await setAppState('active');
    await waitFor(() => {
      expect(api.callsTo(key)).toHaveLength(4);
    });
  });

  it('MID-22 (ux.md §12.3, c; BAIXO do seguranca): no perfil de outra conta, nenhum reel é consultado, nem o que chega como publicado com o vídeo ainda não pronto (fora do contrato) e aparece como "Processando"', async () => {
    // O servidor nunca manda o reel em processamento de outra conta (MID-09), e o `useVisibleIds`
    // já o tira da grade. O reel "publicado" com o vídeo ainda não pronto passa por esse filtro e
    // vira o tile "Processando": aí só a regra do próprio perfil impede a consulta.
    const processing = reelPost({
      status: 'processing',
      publishedAt: null,
      media: [pendingVideo()],
    });
    const notReady = reelPost({ media: [pendingVideo()] });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/inicio/u/marinac',
      configure: (fake) => {
        fake.on('GET /v1/users/marinac', {
          status: 200,
          body: {
            handle: 'marinac',
            name: 'Marina Costa',
            bio: null,
            avatarUrl: null,
            accountType: 'personal',
            counts: { posts: 2, connections: 1, creators: 0 },
          },
        });
        fake.on('GET /v1/users/marinac/posts', ({ query }) => ({
          status: 200,
          body: { items: query.type === 'reel' ? [processing, notReady] : [], nextCursor: null },
        }));
        for (const reel of [processing, notReady]) {
          fake.on(`GET /v1/posts/${reel.id}`, {
            status: 200,
            body: {
              ...reel,
              status: 'published',
              publishedAt: reel.createdAt,
              media: [videoMedia()],
            },
          });
        }
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Reels' }));
    // O tile existe e está em "Processando": o caso em que a consulta poderia sair.
    expect(await screen.findByRole('button', { name: 'Reel processando' })).toBeOnTheScreen();
    await advance(3 * SECOND);
    expect(api.callsTo(`GET /v1/posts/${processing.id}`)).toHaveLength(0);
    expect(api.callsTo(`GET /v1/posts/${notReady.id}`)).toHaveLength(0);
    expect(screen.queryByText(PUBLISHED_MESSAGE)).toBeNull();
  });

  it('MID-23 (ux.md §12.3, c; AUTH-15; BAIXO do seguranca): Helena sai da conta com a consulta do tile em voo e Marina entra → a consulta para, e a resposta que chega depois não entra em lugar nenhum (sem Toast, sem tile, sem outra consulta)', async () => {
    const MARINA = personalMe({
      id: '01a189e0-af57-7000-85fe-2054e618feb1',
      email: 'marina@example.com',
      handle: 'marina',
      name: 'Marina Costa',
    });
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    const reel = processingReel();
    const inFlight = deferredReply();
    const { api } = await openOwnReels(reel, inFlight.handler, (fake) => {
      fake.on('POST /v1/auth/logout', { status: 204 });
      fake.on('GET /v1/feed', { status: 200, body: feedPage([]) });
      fake.on('GET /v1/users/marina/posts', { status: 200, body: { items: [], nextCursor: null } });
    });
    const key = `GET /v1/posts/${reel.id}`;
    await waitFor(() => {
      expect(api.callsTo(key)).toHaveLength(1);
    });

    await userEvent.press(screen.getByRole('button', { name: 'Sair da conta' }));
    api.on('POST /v1/auth/login', () => ({ status: 200, body: session(MARINA) }));
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    await fireEvent.changeText(screen.getByLabelText('E-mail'), MARINA.email);
    await fireEvent.changeText(screen.getByLabelText('Senha'), 'cafe-coado-42');
    await userEvent.press(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByTestId('tela-inicio')).toBeOnTheScreen();

    // A resposta da consulta de Helena chega com Marina na tela: pronto, o que daria "Publicado.".
    await inFlight.resolve({ status: 200, body: publishedOf(reel) });
    // Conferido na hora: o Toast (no `ToastProvider` da raiz, que fica entre as contas) sumiria
    // sozinho em alguns segundos.
    await advance(100);
    expect(screen.queryByText(PUBLISHED_MESSAGE)).toBeNull();
    await advance(3 * SECOND);
    expect(api.callsTo(key)).toHaveLength(1);

    // No perfil de Marina, nada do reel de Helena.
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    await userEvent.press(await screen.findByRole('tab', { name: 'Reels' }));
    await advance(3 * SECOND);
    expect(screen.queryByTestId(`reel-${reel.id}`)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reel/ })).toBeNull();
    expect(screen.queryByText(PUBLISHED_MESSAGE)).toBeNull();
    expect(api.callsTo(key)).toHaveLength(1);
  });
});
