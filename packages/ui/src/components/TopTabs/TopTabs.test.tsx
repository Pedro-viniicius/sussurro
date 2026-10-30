import { screen, userEvent } from '@testing-library/react-native';

import { TopTabs } from './TopTabs';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

const feedTabs = [
  { key: 'photo', label: 'Fotos', accessibilityLabel: 'Fotos' },
  { key: 'text', label: 'Textos', accessibilityLabel: 'Textos' },
  { key: 'reel', label: 'Reels', accessibilityLabel: 'Reels' },
] as const;

describe('TopTabs', () => {
  it('texto: lista de abas com a selecionada marcada', async () => {
    await renderUi(<TopTabs tabs={feedTabs} value="photo" onChange={jest.fn()} />);
    expect(screen.getByTestId('top-tabs')).toHaveProp('accessibilityRole', 'tablist');
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'Fotos' })).toBeSelected();
    expect(screen.getByRole('tab', { name: 'Textos' })).not.toBeSelected();
    expect(screen.getByText('Fotos')).toHaveStyle({ color: theme.colors.black });
    expect(screen.getByText('Textos')).toHaveStyle({ color: theme.colors.grey });
    expect(screen.getByTestId('top-tabs-indicator')).toHaveStyle({
      backgroundColor: theme.colors.blue,
      height: 2,
    });
  });

  it('tocar em outra aba chama onChange; tocar na atual não', async () => {
    const onChange = jest.fn();
    await renderUi(<TopTabs tabs={feedTabs} value="photo" onChange={onChange} />);
    await userEvent.press(screen.getByRole('tab', { name: 'Reels' }));
    expect(onChange).toHaveBeenCalledWith('reel');
    await userEvent.press(screen.getByRole('tab', { name: 'Fotos' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ícone (perfil): rótulos acessíveis e sublinhado preto', async () => {
    await renderUi(
      <TopTabs
        variant="icon"
        value="grid"
        onChange={jest.fn()}
        tabs={[
          { key: 'grid', icon: 'grid-3x3', accessibilityLabel: 'Fotos' },
          { key: 'text', icon: 'align-left', accessibilityLabel: 'Textos' },
          { key: 'reel', icon: 'square-play', accessibilityLabel: 'Reels' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Fotos' })).toBeSelected();
    expect(screen.getByRole('tab', { name: 'Reels' })).toBeOnTheScreen();
    expect(screen.queryByText('Fotos')).not.toBeOnTheScreen();
    expect(screen.getByTestId('top-tabs-indicator')).toHaveStyle({
      backgroundColor: theme.colors.black,
    });
  });
});
