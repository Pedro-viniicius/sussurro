import { fireEvent, screen, userEvent } from '@testing-library/react-native';

import { PostPhoto, type PostPhotoProps } from './PostPhoto';
import { renderUi } from '../../test-utils/render';

const NOW = new Date(2026, 9, 29, 10, 0, 0);

function props(overrides: Partial<PostPhotoProps> = {}): PostPhotoProps {
  return {
    author: { handle: 'marinac', name: 'Marina Costa' },
    relation: 'connection',
    images: [
      { key: 'm1', uri: 'https://cdn.teste/m1.jpg' },
      { key: 'm2', uri: 'https://cdn.teste/m2.jpg' },
    ],
    caption: 'Domingo de manhã no Passaúna. Ninguém por perto, só o barulho da água.',
    likeCount: 6,
    liked: false,
    commentCount: 2,
    publishedAt: new Date(NOW.getTime() - 18 * 60_000),
    now: NOW,
    width: 390,
    onLike: jest.fn(),
    onOpenComments: jest.fn(),
    onOpenAuthor: jest.fn(),
    ...overrides,
  };
}

describe('PostPhoto (p06, 2.10)', () => {
  it('2.10 CA1: cabeçalho, 4:5, contador "1/2", pontos, "6 curtidas", legenda, comentários e tempo', async () => {
    await renderUi(<PostPhoto {...props()} />);
    expect(
      screen.getByRole('button', { name: 'Abrir perfil de @marinac, Conexão' }),
    ).toBeOnTheScreen();
    expect(screen.getByText('Conexão')).toBeOnTheScreen();
    expect(screen.getByTestId('post-photo-media')).toHaveStyle({ width: 390, height: 488 });
    expect(screen.getByTestId('post-photo-counter')).toHaveTextContent('1/2');
    expect(screen.getByTestId('post-photo-dots')).toBeTruthy();
    expect(screen.getByText('6 curtidas')).toBeOnTheScreen();
    expect(screen.getByText(/Domingo de manhã no Passaúna/)).toBeOnTheScreen();
    expect(screen.getByText('Ver todos os 2 comentários')).toBeOnTheScreen();
    expect(screen.getByTestId('post-photo-time')).toHaveTextContent('Há 18 minutos');
    expect(screen.getByLabelText('Foto 1 de 2 de @marinac')).toBeOnTheScreen();
  });

  it('2.10 CA1: singular ("1 curtida", "Ver 1 comentário") e linhas ocultas com 0', async () => {
    await renderUi(<PostPhoto {...props({ likeCount: 1, commentCount: 1 })} />);
    expect(screen.getByText('1 curtida')).toBeOnTheScreen();
    expect(screen.getByText('Ver 1 comentário')).toBeOnTheScreen();
    await renderUi(<PostPhoto {...props({ likeCount: 0, commentCount: 0 })} />);
    expect(screen.queryByText(/curtida/)).not.toBeOnTheScreen();
    expect(screen.queryByText(/^Ver /)).not.toBeOnTheScreen();
  });

  it('setas: próxima e anterior mudam o contador; nas pontas a seta some', async () => {
    await renderUi(<PostPhoto {...props()} />);
    expect(screen.queryByRole('button', { name: 'Foto anterior' })).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Próxima foto' }));
    expect(screen.getByTestId('post-photo-counter')).toHaveTextContent('2/2');
    expect(screen.queryByRole('button', { name: 'Próxima foto' })).not.toBeOnTheScreen();
    await fireEvent(screen.getByTestId('post-photo-media'), 'accessibilityAction', {
      nativeEvent: { actionName: 'decrement' },
    });
    expect(screen.getByTestId('post-photo-counter')).toHaveTextContent('1/2');
  });

  it('uma foto: sem contador, sem setas e sem pontos', async () => {
    await renderUi(<PostPhoto {...props({ images: [{ key: 'm1', uri: 'https://x/1.jpg' }] })} />);
    expect(screen.queryByTestId('post-photo-counter')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('post-photo-dots')).not.toBeOnTheScreen();
    expect(screen.getByLabelText('Foto de @marinac')).toBeOnTheScreen();
  });

  it('curtir chama onLike; curtido mostra o coração preenchido com estado selecionado', async () => {
    const p = props({ liked: true });
    await renderUi(<PostPhoto {...p} />);
    const heart = screen.getByRole('button', { name: 'Curtido' });
    expect(heart).toBeSelected();
    expect(
      screen.getByTestId('post-photo-like-filled', { includeHiddenElements: true }),
    ).toBeTruthy();
    await userEvent.press(heart);
    expect(p.onLike).toHaveBeenCalled();
  });

  it('A-06: com canLike=false (criador) o coração não aparece', async () => {
    await renderUi(<PostPhoto {...props({ canLike: false })} />);
    expect(screen.queryByRole('button', { name: 'Curtir' })).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Comentar' })).toBeOnTheScreen();
  });

  it('próprio post: sem rótulo de relação e com "Mais opções"', async () => {
    const onMore = jest.fn();
    await renderUi(<PostPhoto {...props({ relation: 'self', onMore })} />);
    expect(screen.queryByText('Conexão')).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Mais opções' }));
    expect(onMore).toHaveBeenCalled();
  });

  it('"Ver todos os N comentários" e o autor chamam os callbacks', async () => {
    const p = props({ relation: 'creator' });
    await renderUi(<PostPhoto {...p} />);
    await userEvent.press(screen.getByText('Ver todos os 2 comentários'));
    expect(p.onOpenComments).toHaveBeenCalled();
    await userEvent.press(
      screen.getByRole('button', { name: 'Abrir perfil de @marinac, Criador' }),
    );
    expect(p.onOpenAuthor).toHaveBeenCalled();
  });

  it('foto que falha mostra o aviso e o toque tenta de novo', async () => {
    await renderUi(<PostPhoto {...props({ images: [{ key: 'm9', uri: 'https://x/9.jpg' }] })} />);
    await fireEvent(screen.getByTestId('post-image-m9-img'), 'error', {
      nativeEvent: { error: 'falhou' },
    });
    const retry = screen.getByRole('button', { name: /Não foi possível carregar a foto/ });
    expect(screen.getByText('Não foi possível carregar a foto')).toBeOnTheScreen();
    await userEvent.press(retry);
    expect(screen.getByTestId('post-image-m9-img')).toBeTruthy();
  });
});
