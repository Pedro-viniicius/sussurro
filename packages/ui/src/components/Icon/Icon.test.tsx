import { screen } from '@testing-library/react-native';

import { Icon, iconNames } from './Icon';
import { renderUi } from '../../test-utils/render';

describe('Icon', () => {
  it('é decorativo por padrão (some do leitor de tela)', async () => {
    await renderUi(<Icon name="heart" />);
    const icon = screen.getByTestId('icon-heart', { includeHiddenElements: true });
    expect(icon.props.accessible).toBe(false);
    expect(icon.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(screen.queryByRole('image')).not.toBeOnTheScreen();
  });

  it('com rótulo vira imagem acessível', async () => {
    await renderUi(<Icon name="lock" accessibilityLabel="Bloqueado" />);
    expect(screen.getByRole('image', { name: 'Bloqueado' })).toBeOnTheScreen();
  });

  it('ativo usa traço 2,75; inativo, 2', async () => {
    await renderUi(
      <>
        <Icon name="search" active accessibilityLabel="ativo" />
        <Icon name="search" accessibilityLabel="inativo" />
      </>,
    );
    const strokeOf = (label: string) =>
      screen
        .getByRole('image', { name: label })
        .queryAll((node) => node.props.strokeWidth !== undefined)[0]?.props.strokeWidth as unknown;
    expect(strokeOf('inativo')).toBe(2);
    expect(strokeOf('ativo')).toBe(2.75);
  });

  it('house ativo troca pelo HouseFill (porta vazada)', async () => {
    await renderUi(<Icon name="house" active />);
    expect(screen.getByTestId('icon-house-fill', { includeHiddenElements: true })).toBeTruthy();
  });

  it('todos os ícones do ux.md §6.11 renderizam', async () => {
    expect(iconNames.length).toBeGreaterThanOrEqual(37);
    for (const name of iconNames) {
      await renderUi(<Icon name={name} />);
      expect(screen.getByTestId(`icon-${name}`, { includeHiddenElements: true })).toBeTruthy();
    }
  });
});
