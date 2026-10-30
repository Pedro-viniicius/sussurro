import { act, screen, userEvent } from '@testing-library/react-native';

import {
  REEL_ERROR_MESSAGE,
  REEL_PROCESSING_MESSAGE,
  REEL_REPLAY_LABEL,
  ReelViewer,
  type ReelViewerProps,
} from './ReelViewer';
import { renderUi, type RenderUiOptions } from '../../test-utils/render';
import { fakeVideo } from '../../test-utils/video-mock';

const SOURCE = {
  key: 'm1',
  uri: 'https://cdn.teste/media/m1/video.mp4',
  posterUri: 'https://cdn.teste/media/m1/poster.jpg',
};

beforeEach(() => {
  fakeVideo.reset();
});

async function renderViewer(props: Partial<ReelViewerProps> = {}, options: RenderUiOptions = {}) {
  const handlers = {
    onClose: jest.fn(),
    onLike: jest.fn(),
    onOpenComments: jest.fn(),
    onOpenAuthor: jest.fn(),
    onMore: jest.fn(),
    onRetry: jest.fn(),
  };
  const element = (extra: Partial<ReelViewerProps> = {}) => (
    <ReelViewer
      source={SOURCE}
      author={{ handle: 'cozinhadabia', name: 'Beatriz Lemos' }}
      relation="creator"
      caption="Receita do pão de quinta"
      likeCount={12}
      liked={false}
      commentCount={3}
      {...handlers}
      {...props}
      {...extra}
    />
  );
  const result = await renderUi(element(), options);
  return {
    ...handlers,
    rerender: (extra: Partial<ReelViewerProps>) => result.rerender(element(extra)),
  };
}

/** Chamadas ao player depois de um ponto (para ver o que aconteceu "sozinho"). */
function callsAfter(index: number): string[] {
  return fakeVideo.last().calls.slice(index);
}

describe('ReelViewer (ux.md §4.4, história 5.5)', () => {
  it('5.5: só o reel aberto toca, com som, sem loop, sem segundo plano e sem notificação', async () => {
    await renderViewer();
    expect(fakeVideo.players).toHaveLength(1);
    const player = fakeVideo.last();
    expect(player.source).toEqual({ uri: SOURCE.uri });
    expect(player.calls).toContain('play');
    expect(player.loop).toBe(false);
    expect(player.muted).toBe(false);
    expect(player.staysActiveInBackground).toBe(false);
    expect(player.showNowPlayingNotification).toBe(false);
    expect(screen.getByRole('button', { name: 'Reel de @cozinhadabia' })).toBeOnTheScreen();
    expect(screen.getByText('cozinhadabia · Criador')).toBeOnTheScreen();
    expect(screen.getByTestId('reel-viewer-legenda')).toHaveTextContent('Receita do pão de quinta');
  });

  it('carregando: poster com spinner até o player ficar pronto', async () => {
    await renderViewer();
    expect(screen.getByTestId('reel-viewer-poster')).toBeOnTheScreen();
    expect(screen.getByTestId('reel-viewer-carregando')).toBeOnTheScreen();
    await act(() => {
      fakeVideo.last().setStatus('readyToPlay');
    });
    expect(screen.queryByTestId('reel-viewer-carregando')).not.toBeOnTheScreen();
  });

  it('5.5 CA1: ao terminar, para no último quadro com "Assistir de novo" e nunca abre outro reel', async () => {
    const { onClose } = await renderViewer();
    const player = fakeVideo.last();
    await act(() => {
      player.setStatus('readyToPlay');
    });
    const before = player.calls.length;
    await act(() => {
      player.timeUpdate(15);
      player.finish();
    });

    expect(screen.getByRole('button', { name: REEL_REPLAY_LABEL })).toBeOnTheScreen();
    expect(screen.getByTestId('reel-viewer-progresso')).toHaveAccessibilityValue({ now: 100 });
    // Nada recomeça nem troca de vídeo sozinho; nenhum outro player é criado; o visualizador fica.
    expect(callsAfter(before)).not.toContain('play');
    expect(callsAfter(before)).not.toContain('replace');
    expect(callsAfter(before)).not.toContain('replay');
    expect(fakeVideo.players).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.press(screen.getByRole('button', { name: REEL_REPLAY_LABEL }));
    expect(callsAfter(before)).toEqual(expect.arrayContaining(['replay', 'play']));
    expect(screen.queryByRole('button', { name: REEL_REPLAY_LABEL })).not.toBeOnTheScreen();
    expect(fakeVideo.players).toHaveLength(1);
  });

  it('toque no vídeo pausa e retoma; o ▶ fica no centro enquanto pausado', async () => {
    await renderViewer();
    const player = fakeVideo.last();
    const surface = screen.getByRole('button', { name: 'Reel de @cozinhadabia' });
    await userEvent.press(surface);
    expect(player.calls.at(-1)).toBe('pause');
    expect(screen.getByTestId('reel-viewer-pausado')).toBeOnTheScreen();
    await userEvent.press(surface);
    expect(player.calls.at(-1)).toBe('play');
    expect(screen.queryByTestId('reel-viewer-pausado')).not.toBeOnTheScreen();
  });

  it('5.5 CA2: com leitor de tela há o botão explícito "Pausar"/"Reproduzir" e os controles não somem', async () => {
    await renderViewer({}, { screenReader: true });
    const player = fakeVideo.last();
    await userEvent.press(screen.getByRole('button', { name: 'Pausar' }));
    expect(player.calls.at(-1)).toBe('pause');
    expect(screen.getByRole('button', { name: 'Reproduzir' })).toBeOnTheScreen();
    for (const name of ['Fechar', 'Desativar som', 'Curtir', 'Comentar, 3 comentários']) {
      expect(screen.getByRole('button', { name })).toBeOnTheScreen();
    }
    await userEvent.press(screen.getByRole('button', { name: 'Reproduzir' }));
    expect(player.calls.at(-1)).toBe('play');
    // Os controles continuam na tela com o vídeo tocando e depois do fim.
    await act(() => {
      player.finish();
    });
    for (const name of ['Fechar', 'Desativar som', 'Curtir', REEL_REPLAY_LABEL]) {
      expect(screen.getByRole('button', { name })).toBeOnTheScreen();
    }
  });

  it('sem leitor de tela não há o botão extra (o toque no vídeo pausa)', async () => {
    await renderViewer({}, { screenReader: false });
    expect(screen.queryByRole('button', { name: 'Pausar' })).not.toBeOnTheScreen();
  });

  it('fora de foco (comentários por cima) pausa; de volta, continua', async () => {
    const { rerender } = await renderViewer();
    const player = fakeVideo.last();
    await rerender({ active: false });
    expect(player.calls.at(-1)).toBe('pause');
    await rerender({ active: true });
    expect(player.calls.at(-1)).toBe('play');
  });

  it('som: alterna mudo', async () => {
    await renderViewer();
    await userEvent.press(screen.getByRole('button', { name: 'Desativar som' }));
    expect(fakeVideo.last().muted).toBe(true);
    await userEvent.press(screen.getByRole('button', { name: 'Ativar som' }));
    expect(fakeVideo.last().muted).toBe(false);
  });

  it('erro de reprodução: mensagem e "Tentar de novo" com um player novo', async () => {
    const { onRetry } = await renderViewer();
    await act(() => {
      fakeVideo.last().setStatus('error');
    });
    expect(screen.getByText(REEL_ERROR_MESSAGE)).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onRetry).toHaveBeenCalled();
    expect(fakeVideo.players).toHaveLength(2);
    expect(screen.queryByText(REEL_ERROR_MESSAGE)).not.toBeOnTheScreen();
  });

  it('processando (só o autor vê): mensagem, sem player; ✕ fecha', async () => {
    const { onClose } = await renderViewer({
      status: 'processing',
      source: { key: 'm1', uri: null, posterUri: null },
    });
    expect(screen.getByText(REEL_PROCESSING_MESSAGE)).toBeOnTheScreen();
    expect(fakeVideo.players).toHaveLength(0);
    await userEvent.press(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('curtir, comentar, autor e ⋯ chamam o app; o criador vê só o número de curtidas', async () => {
    const handlers = await renderViewer();
    await userEvent.press(screen.getByRole('button', { name: 'Curtir' }));
    await userEvent.press(screen.getByRole('button', { name: 'Comentar, 3 comentários' }));
    await userEvent.press(
      screen.getByRole('button', { name: 'Abrir perfil de @cozinhadabia, Criador' }),
    );
    await userEvent.press(screen.getByRole('button', { name: 'Mais opções' }));
    expect(handlers.onLike).toHaveBeenCalled();
    expect(handlers.onOpenComments).toHaveBeenCalled();
    expect(handlers.onOpenAuthor).toHaveBeenCalled();
    expect(handlers.onMore).toHaveBeenCalled();

    await handlers.rerender({ canLike: false });
    expect(screen.queryByRole('button', { name: 'Curtir' })).not.toBeOnTheScreen();
    expect(screen.getByLabelText('12 curtidas')).toBeOnTheScreen();
  });
});
