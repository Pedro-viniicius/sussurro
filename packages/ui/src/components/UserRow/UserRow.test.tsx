import { screen, userEvent } from '@testing-library/react-native';

import { UserRow } from './UserRow';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';
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

  it('PROX-65 (ux.md §11.18, Contas bloqueadas): sem subtitleLines, o @ e o subtítulo ficam em 1 linha, sem o padding das 2 linhas (as outras listas não mudam)', async () => {
    await renderUi(<UserRow handle="caio.r" subtitle="Bloqueio em 3 set 2025" />);
    expect(screen.getByText('caio.r').props.numberOfLines).toBe(1);
    expect(screen.getByText('Bloqueio em 3 set 2025').props.numberOfLines).toBe(1);
    expect(screen.getByTestId('user-row-caio.r')).not.toHaveStyle({
      paddingVertical: theme.space[8],
    });
    expect(screen.getByTestId('user-row-caio.r')).toHaveStyle({ minHeight: 64 });
  });

  it('PROX-65 (ux.md §11.18, Contas bloqueadas): com subtitleLines={2}, o subtítulo aceita 2 linhas e a linha ganha paddingVertical 8; o @ continua em 1 linha', async () => {
    await renderUi(
      <UserRow
        handle="helena.souza.fotografia"
        subtitle="Bloqueio em 3 set 2025"
        subtitleLines={2}
        action={<Button variant="secondary" size="sm" label="Desbloquear" onPress={jest.fn()} />}
      />,
    );
    expect(screen.getByText('helena.souza.fotografia').props.numberOfLines).toBe(1);
    expect(screen.getByText('Bloqueio em 3 set 2025').props.numberOfLines).toBe(2);
    expect(screen.getByTestId('user-row-helena.souza.fotografia')).toHaveStyle({
      paddingVertical: theme.space[8],
      minHeight: 64,
    });
    // O leitor de tela lê o @ e a data inteiros, pelo rótulo da linha.
    expect(
      screen.getByLabelText('@helena.souza.fotografia, Bloqueio em 3 set 2025'),
    ).toBeOnTheScreen();
  });
});
