import { screen, userEvent } from '@testing-library/react-native';

import { IconButton } from './IconButton';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

describe('IconButton', () => {
  it('área de toque 44 com o rótulo obrigatório', async () => {
    const onPress = jest.fn();
    await renderUi(<IconButton icon="heart" accessibilityLabel="Notificações" onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Notificações' });
    expect(button).toHaveStyle({ minWidth: 44, minHeight: 44 });
    await userEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('6.2: o ponto azul aparece só com `dot`', async () => {
    const { rerender } = await renderUi(
      <IconButton
        icon="heart"
        accessibilityLabel="Notificações, há novidades"
        onPress={jest.fn()}
        dot
        testID="coracao"
      />,
    );
    expect(screen.getByTestId('coracao-dot')).toHaveStyle({
      width: theme.size.unreadDot,
      backgroundColor: theme.colors.blue,
    });
    await rerender(
      <IconButton
        icon="heart"
        accessibilityLabel="Notificações"
        onPress={jest.fn()}
        testID="coracao"
      />,
    );
    expect(screen.queryByTestId('coracao-dot')).not.toBeOnTheScreen();
  });
});
