import { fireEvent, screen, userEvent } from '@testing-library/react-native';

import { PostText, type PostTextProps } from './PostText';
import { renderUi } from '../../test-utils/render';

const NOW = new Date(2026, 9, 29, 10, 0, 0);

function props(overrides: Partial<PostTextProps> = {}): PostTextProps {
  return {
    author: { handle: 'juprado', name: 'Juliana Prado' },
    relation: 'connection',
    text: 'Alguém mais tentou ficar uma semana sem abrir o celular antes do café?',
    publishedAt: new Date(NOW.getTime() - 40 * 60_000),
    now: NOW,
    likeCount: 4,
    liked: false,
    commentCount: 1,
    onLike: jest.fn(),
    onComment: jest.fn(),
    onOpen: jest.fn(),
    onOpenAuthor: jest.fn(),
    ...overrides,
  };
}

describe('PostText (p07, 2.10)', () => {
  it('p07: @, "40 min", texto inteiro e os números ao lado dos ícones', async () => {
    await renderUi(<PostText {...props()} />);
    expect(screen.getByText('juprado')).toBeOnTheScreen();
    expect(screen.getByTestId('post-text-time')).toHaveTextContent('40 min');
    expect(screen.getByText(/uma semana sem abrir o celular/)).toBeOnTheScreen();
    expect(screen.getByTestId('post-text-likes')).toHaveTextContent('4');
    expect(screen.getByTestId('post-text-comments')).toHaveTextContent('1');
  });

  it('p07: número 0 aparece; "ontem" no tempo curto', async () => {
    await renderUi(
      <PostText
        {...props({ likeCount: 0, commentCount: 0, publishedAt: new Date(2026, 9, 28, 8, 0) })}
      />,
    );
    expect(screen.getByTestId('post-text-likes')).toHaveTextContent('0');
    expect(screen.getByTestId('post-text-comments')).toHaveTextContent('0');
    expect(screen.getByTestId('post-text-time')).toHaveTextContent('ontem');
  });

  it('o item é um grupo com o rótulo falado e ações de curtir, comentar e abrir', async () => {
    const p = props();
    await renderUi(<PostText {...p} />);
    const content = screen.getByLabelText(/^@juprado, Conexão, há 40 minutos: Alguém mais tentou/);
    await fireEvent(content, 'accessibilityAction', { nativeEvent: { actionName: 'like' } });
    await fireEvent(content, 'accessibilityAction', { nativeEvent: { actionName: 'comment' } });
    await fireEvent(content, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    expect(p.onLike).toHaveBeenCalledTimes(1);
    expect(p.onComment).toHaveBeenCalledTimes(1);
    expect(p.onOpen).toHaveBeenCalledTimes(1);
    await userEvent.press(screen.getByRole('button', { name: 'Curtir' }));
    expect(p.onLike).toHaveBeenCalledTimes(2);
    await userEvent.press(screen.getByRole('button', { name: /^Comentar, 1 comentário/ }));
    expect(p.onComment).toHaveBeenCalledTimes(2);
  });

  it('A-06: com canLike=false o coração fica só como número, sem botão', async () => {
    await renderUi(<PostText {...props({ canLike: false, likeCount: 97 })} />);
    expect(screen.queryByRole('button', { name: 'Curtir' })).not.toBeOnTheScreen();
    expect(screen.getByLabelText('97 curtidas')).toBeOnTheScreen();
  });
});
