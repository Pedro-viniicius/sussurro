import { screen, userEvent, waitFor, within } from '@testing-library/react-native';

import { CommentsSheet, type CommentsSheetProps } from './CommentsSheet';
import type { CommentThreadView } from './types';
import { renderUi } from '../../test-utils/render';

const NOW = new Date(2026, 9, 29, 10, 0, 0);

const THREADS: CommentThreadView[] = [
  {
    id: 'c1',
    parentId: null,
    author: { handle: 'lucasf', profileVisible: true },
    body: 'Que luz bonita!',
    createdAt: new Date(NOW.getTime() - 2 * 3_600_000),
    canDelete: false,
    replies: [
      {
        id: 'c2',
        parentId: 'c1',
        author: { handle: 'marinac', profileVisible: false },
        body: 'Obrigada!',
        createdAt: new Date(NOW.getTime() - 3_600_000),
        canDelete: true,
      },
    ],
  },
];

function props(overrides: Partial<CommentsSheetProps> = {}): CommentsSheetProps {
  return {
    threads: THREADS,
    status: 'ready',
    onRetry: jest.fn(),
    hasMore: false,
    onLoadMore: jest.fn(),
    onClose: jest.fn(),
    canComment: true,
    canReply: true,
    currentUser: { handle: 'helena', name: 'Helena Souza' },
    onSubmit: jest.fn(),
    onDelete: jest.fn(),
    onOpenAuthor: jest.fn(),
    maxLength: 500,
    now: NOW,
    ...overrides,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

/** Ações do menu da pressão longa, na ordem, sem o "Cancelar". */
function menuLabels(): string[] {
  return within(screen.getByTestId('comments-menu'))
    .getAllByRole('button')
    .map((node) => String(node.props.accessibilityLabel))
    .filter((label) => label !== 'Cancelar');
}

describe('CommentsSheet (ux.md §4.3)', () => {
  it('título, ✕, comentário e resposta recuada com @ e tempo', async () => {
    const p = props();
    await renderUi(<CommentsSheet {...p} />);
    expect(screen.getByRole('header', { name: 'Comentários' })).toBeOnTheScreen();
    expect(screen.getByText('Que luz bonita!')).toBeOnTheScreen();
    expect(screen.getByText('Obrigada!')).toBeOnTheScreen();
    expect(screen.getByText('· 2 h')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Fechar' }));
    expect(p.onClose).toHaveBeenCalled();
  });

  it('PERM-10c (D11): o @ só é tocável quando profileVisible', async () => {
    const p = props();
    await renderUi(<CommentsSheet {...p} />);
    await userEvent.press(screen.getByRole('link', { name: 'Perfil de @lucasf' }));
    expect(p.onOpenAuthor).toHaveBeenCalledWith('lucasf');
    expect(screen.queryByRole('link', { name: 'Perfil de @marinac' })).not.toBeOnTheScreen();
    expect(screen.getByTestId('comment-c2-author-text')).toHaveTextContent('marinac');
  });

  it('comentar: "Publicar" desabilitado vazio; envia e limpa o campo', async () => {
    const p = props();
    await renderUi(<CommentsSheet {...p} />);
    expect(screen.getByRole('button', { name: 'Publicar' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Comentário'), 'Lindo demais');
    await userEvent.press(screen.getByRole('button', { name: 'Publicar' }));
    expect(p.onSubmit).toHaveBeenCalledWith('Lindo demais', null);
    expect(screen.getByLabelText('Comentário')).toHaveDisplayValue('');
  });

  it('responder: chip "Respondendo a @x" e parentId do comentário de primeiro nível', async () => {
    const p = props();
    await renderUi(<CommentsSheet {...p} />);
    // Responder a uma resposta responde na mesma conversa (1 nível, 2.8 CA2).
    await userEvent.press(screen.getByRole('button', { name: 'Responder a @marinac' }));
    expect(screen.getByText('Respondendo a @marinac')).toBeOnTheScreen();
    await userEvent.type(screen.getByLabelText('Resposta para @marinac'), 'De nada');
    await userEvent.press(screen.getByRole('button', { name: 'Publicar' }));
    expect(p.onSubmit).toHaveBeenCalledWith('De nada', 'c1');
    expect(screen.queryByText(/Respondendo a/)).not.toBeOnTheScreen();
  });

  it('A-06: sem canComment, o campo só aparece ao tocar em "Responder"', async () => {
    await renderUi(<CommentsSheet {...props({ canComment: false })} />);
    expect(screen.queryByLabelText('Comentário')).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Responder a @lucasf' }));
    expect(screen.getByLabelText('Resposta para @lucasf')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Cancelar resposta' }));
    expect(screen.queryByLabelText('Resposta para @lucasf')).not.toBeOnTheScreen();
  });

  it('sem canReply não há "Responder"', async () => {
    await renderUi(<CommentsSheet {...props({ canReply: false, canComment: false })} />);
    expect(screen.queryByRole('button', { name: /^Responder/ })).not.toBeOnTheScreen();
  });

  it('pressão longa: menu com "Excluir" só quando canDelete', async () => {
    const p = props();
    await renderUi(<CommentsSheet {...p} />);
    await userEvent.longPress(screen.getByTestId('comment-c2'));
    expect(screen.getByRole('header', { name: 'Comentário de @marinac' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => {
      expect(p.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }));
    });
    await userEvent.longPress(screen.getByTestId('comment-c1'));
    expect(menuLabels()).toEqual(['Responder']);
  });

  it('D-UX14: em comentário de outra conta, "Denunciar" vem antes de "Bloquear"; no próprio, não aparecem', async () => {
    const onReport = jest.fn();
    const onBlock = jest.fn();
    const own: CommentThreadView = {
      id: 'c3',
      parentId: null,
      author: { handle: 'helena', profileVisible: true },
      body: 'Meu comentário',
      createdAt: NOW,
      canDelete: true,
      replies: [],
    };
    await renderUi(<CommentsSheet {...props({ threads: [...THREADS, own], onReport, onBlock })} />);
    await userEvent.longPress(screen.getByTestId('comment-c2'));
    expect(menuLabels()).toEqual(['Responder', 'Excluir', 'Denunciar', 'Bloquear']);
    await userEvent.press(screen.getByRole('button', { name: 'Denunciar' }));
    await waitFor(() => {
      expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }));
    });

    await userEvent.longPress(screen.getByTestId('comment-c1'));
    await userEvent.press(screen.getByRole('button', { name: 'Bloquear' }));
    await waitFor(() => {
      expect(onBlock).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    });

    await userEvent.longPress(screen.getByTestId('comment-c3'));
    expect(menuLabels()).toEqual(['Responder', 'Excluir']);
    // Para o leitor de tela, as mesmas ações ficam no item.
    const actions = screen
      .getByTestId('comment-c1')
      .props.accessibilityActions.map((action: { label: string }) => action.label);
    expect(actions).toEqual(['Responder', 'Denunciar', 'Bloquear', 'Abrir perfil de @lucasf']);
  });

  it('estados: carregando, erro com "Tentar de novo", vazio e item "Não publicado"', async () => {
    const p = props({ status: 'error' });
    await renderUi(<CommentsSheet {...p} />);
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(p.onRetry).toHaveBeenCalled();

    await renderUi(<CommentsSheet {...props({ status: 'loading' })} />);
    expect(screen.getByTestId('comments-loading')).toBeTruthy();

    await renderUi(<CommentsSheet {...props({ threads: [] })} />);
    expect(screen.getByText('Ainda não há comentários. Comece a conversa.')).toBeOnTheScreen();

    const onRetrySend = jest.fn();
    await renderUi(
      <CommentsSheet
        {...props({
          onRetrySend,
          threads: [{ ...THREADS[0]!, id: 'tmp', status: 'failed', replies: [] }],
        })}
      />,
    );
    const failed = within(screen.getByTestId('comment-tmp'));
    expect(failed.getByText('Não publicado.')).toBeOnTheScreen();
    await userEvent.press(failed.getByRole('button', { name: 'Tentar de novo' }));
    expect(onRetrySend).toHaveBeenCalled();
  });

  it('contador "x/500" aparece a partir de 450 e passa a danger acima do limite', async () => {
    await renderUi(<CommentsSheet {...props()} />);
    await userEvent.paste(screen.getByLabelText('Comentário'), 'a'.repeat(449));
    expect(screen.queryByTestId('comment-composer-counter')).not.toBeOnTheScreen();
    await userEvent.paste(screen.getByLabelText('Comentário'), 'a'.repeat(501));
    expect(screen.getByTestId('comment-composer-counter')).toHaveTextContent('501/500');
    expect(screen.getByRole('button', { name: 'Publicar' })).toBeDisabled();
  });

  it('"Ver mais comentários" e falha da página seguinte', async () => {
    const p = props({ hasMore: true });
    await renderUi(<CommentsSheet {...p} />);
    await userEvent.press(screen.getByRole('button', { name: 'Ver mais comentários' }));
    expect(p.onLoadMore).toHaveBeenCalledTimes(1);
    await renderUi(<CommentsSheet {...props({ hasMore: true, loadMoreFailed: true })} />);
    expect(screen.getByText('Não carregou.')).toBeOnTheScreen();
  });
});
