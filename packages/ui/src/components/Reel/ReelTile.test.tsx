import { screen, userEvent } from '@testing-library/react-native';

import { ReelTile } from './ReelTile';
import { renderUi } from '../../test-utils/render';

const THUMB = { key: 'm1', uri: 'https://cdn.teste/media/m1/poster.jpg' };

describe('ReelTile (p08, ux.md §6.14)', () => {
  it('5.4 CA1: 9:16, duração legível sobre a miniatura com scrim e toque', async () => {
    const onPress = jest.fn();
    await renderUi(
      <ReelTile
        thumb={THUMB}
        duration="0:42"
        width={126}
        onPress={onPress}
        accessibilityLabel="Reel de @marinac, 42 segundos"
      />,
    );
    const tile = screen.getByRole('button', { name: 'Reel de @marinac, 42 segundos' });
    expect(tile).toHaveStyle({ width: 126, height: 224 });
    expect(screen.getByTestId('reel-tile-m1-duration')).toHaveTextContent('0:42');
    // O texto branco fica sobre o mediaScrim (contraste em miniaturas claras, ux.md §7.1).
    expect(screen.getByTestId('reel-tile-m1-scrim', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId('icon-play', { includeHiddenElements: true })).toBeTruthy();
    await userEvent.press(tile);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('MID-09: processando mostra spinner e "Processando", sem duração nem toque', async () => {
    await renderUi(
      <ReelTile
        thumb={{ key: 'm2', uri: null }}
        duration={null}
        width={100}
        status="processing"
        accessibilityLabel="Reel"
      />,
    );
    expect(screen.getByText('Processando')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Reel processando' })).toBeDisabled();
    expect(screen.queryByTestId('reel-tile-m2-duration')).not.toBeOnTheScreen();
  });

  it('5.6 CA1: falhou mostra "Falhou" e o toque abre as ações', async () => {
    const onPress = jest.fn();
    await renderUi(
      <ReelTile
        thumb={{ key: 'm3', uri: null }}
        duration={null}
        width={100}
        status="failed"
        onPress={onPress}
        accessibilityLabel="Reel"
      />,
    );
    expect(screen.getByText('Falhou')).toBeOnTheScreen();
    const tile = screen.getByRole('button', { name: 'Reel não publicado' });
    expect(tile).toHaveProp('accessibilityHint', 'Mostra as opções Tentar de novo e Excluir');
    await userEvent.press(tile);
    expect(onPress).toHaveBeenCalled();
  });
});
