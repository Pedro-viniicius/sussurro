import { screen, userEvent } from '@testing-library/react-native';

import { UserRow } from './UserRow';
import { renderUi } from '../../test-utils/render';
import { Button } from '../Button/Button';

describe('UserRow (ux.md §6.14)', () => {
  it('@, subtítulo e ação à direita separada do toque na linha', async () => {
    const onPress = jest.fn();
    const onFollow = jest.fn();
    await renderUi(
      <UserRow
        handle="estudioaurora"
        name="Estúdio Aurora"
        subtitle="Estúdio Aurora · 5.067 seguidores"
        onPress={onPress}
        action={<Button size="sm" label="Seguir" onPress={onFollow} />}
      />,
    );
    expect(screen.getByText('estudioaurora')).toBeOnTheScreen();
    expect(screen.getByText('Estúdio Aurora · 5.067 seguidores')).toBeOnTheScreen();
    await userEvent.press(
      screen.getByRole('button', { name: '@estudioaurora, Estúdio Aurora · 5.067 seguidores' }),
    );
    expect(onPress).toHaveBeenCalledTimes(1);
    await userEvent.press(screen.getByRole('button', { name: 'Seguir' }));
    expect(onFollow).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('sem onPress, a linha não é botão', async () => {
    await renderUi(<UserRow handle="caio.r" subtitle="Desde 27 out" />);
    expect(screen.getByLabelText('@caio.r, Desde 27 out')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });
});
