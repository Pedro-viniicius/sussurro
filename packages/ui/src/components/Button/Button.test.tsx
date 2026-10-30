import { screen, userEvent } from '@testing-library/react-native';

import { Button, type ButtonVariant } from './Button';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

describe('Button', () => {
  it.each<[ButtonVariant, string, string]>([
    ['primary', theme.colors.blue, theme.colors.white],
    ['secondary', theme.colors.greySoft, theme.colors.black],
    ['destructive', theme.colors.white, theme.colors.danger],
  ])('variante %s: fundo %s e texto %s', async (variant, background, text) => {
    await renderUi(<Button label="Entrar" variant={variant} onPress={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Entrar' })).toHaveStyle({
      backgroundColor: background,
    });
    expect(screen.getByText('Entrar')).toHaveStyle({ color: text });
  });

  it('link: sem fundo, texto azul', async () => {
    await renderUi(<Button label="Cadastre-se" variant="link" onPress={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Cadastre-se' })).toHaveStyle({
      backgroundColor: 'transparent',
    });
    expect(screen.getByText('Cadastre-se')).toHaveStyle({ color: theme.colors.blue });
  });

  it('tamanhos: lg 44/raio 12 e sm 34/raio 10', async () => {
    await renderUi(
      <>
        <Button label="Grande" onPress={jest.fn()} />
        <Button label="Pequeno" size="sm" onPress={jest.fn()} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Grande' })).toHaveStyle({
      minHeight: 44,
      borderRadius: 12,
    });
    expect(screen.getByRole('button', { name: 'Pequeno' })).toHaveStyle({
      minHeight: 34,
      borderRadius: 10,
    });
  });

  it('chama onPress ao tocar', async () => {
    const onPress = jest.fn();
    await renderUi(<Button label="Seguir" onPress={onPress} />);
    await userEvent.press(screen.getByRole('button', { name: 'Seguir' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('CA5 (0.8): desabilitado não chama onPress e expõe o estado', async () => {
    const onPress = jest.fn();
    await renderUi(<Button label="Entrar" disabled onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Entrar' });
    expect(button).toBeDisabled();
    expect(button).toHaveStyle({ backgroundColor: theme.colors.blueMist });
    await userEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('CA5 (0.8): loading mostra spinner, não chama onPress e fica busy', async () => {
    const onPress = jest.fn();
    await renderUi(<Button label="Entrar" loading onPress={onPress} testID="entrar" />);
    const button = screen.getByRole('button', { name: 'Entrar' });
    expect(button).toBeBusy();
    expect(button).toBeDisabled();
    expect(screen.getByTestId('entrar-spinner')).toBeOnTheScreen();
    await userEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('pressionado (catálogo): primary vira bluePressed', async () => {
    await renderUi(<Button label="Entrar" forcePressed onPress={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Entrar' })).toHaveStyle({
      backgroundColor: theme.colors.bluePressed,
    });
  });

  it('rótulo acessível próprio (Seguir @x) e ícone opcional', async () => {
    await renderUi(
      <Button
        label="Seguir"
        accessibilityLabel="Seguir @cozinhadabia"
        icon="check"
        onPress={jest.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Seguir @cozinhadabia' })).toBeOnTheScreen();
    expect(screen.getByTestId('icon-check', { includeHiddenElements: true })).toBeTruthy();
  });
});
