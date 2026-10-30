import { act, screen, userEvent } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import { Toast } from './Toast';
import { type ShowToastOptions, ToastProvider, useToast } from './ToastProvider';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

describe('Toast', () => {
  it('é um alerta com fundo ink e texto branco', async () => {
    await renderUi(<Toast message="Publicado" variant="success" />);
    const toast = screen.getByTestId('toast');
    expect(toast).toHaveProp('accessibilityRole', 'alert');
    expect(toast).toHaveStyle({ backgroundColor: theme.colors.ink });
    expect(screen.getByText('Publicado')).toHaveStyle({ color: theme.colors.white });
    expect(toast.props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId('icon-check', { includeHiddenElements: true })).toBeTruthy();
  });

  it('erro mostra circle-alert; ação usa blueMist', async () => {
    const onPress = jest.fn();
    await renderUi(
      <Toast
        message="Não foi possível curtir."
        variant="error"
        action={{ label: 'Tentar de novo', onPress }}
      />,
    );
    expect(screen.getByTestId('icon-circle-alert', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText('Tentar de novo')).toHaveStyle({ color: theme.colors.blueMist });
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onPress).toHaveBeenCalled();
  });
});

function Trigger({ options }: { options: ShowToastOptions[] }) {
  const toast = useToast();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        options.forEach((option) => {
          toast.show(option);
        });
      }}
    >
      <Text>mostrar</Text>
    </Pressable>
  );
}

describe('ToastProvider', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('mostra um por vez, em fila, e some depois de 4 s', async () => {
    await renderUi(
      <ToastProvider>
        <Trigger options={[{ message: 'Primeiro' }, { message: 'Segundo' }]} />
      </ToastProvider>,
    );
    await userEvent.press(screen.getByRole('button', { name: 'mostrar' }));
    expect(screen.getByText('Primeiro')).toBeOnTheScreen();
    expect(screen.queryByText('Segundo')).not.toBeOnTheScreen();

    await act(() => {
      jest.advanceTimersByTime(theme.motion.toastVisible);
    });
    expect(screen.queryByText('Primeiro')).not.toBeOnTheScreen();
    expect(screen.getByText('Segundo')).toBeOnTheScreen();

    await act(() => {
      jest.advanceTimersByTime(theme.motion.toastVisible);
    });
    expect(screen.queryByTestId('toast')).not.toBeOnTheScreen();
  });

  it('com ação fica 6 s; tocar na ação fecha', async () => {
    const onPress = jest.fn();
    await renderUi(
      <ToastProvider>
        <Trigger options={[{ message: 'Removido', action: { label: 'Desfazer', onPress } }]} />
      </ToastProvider>,
    );
    await userEvent.press(screen.getByRole('button', { name: 'mostrar' }));
    await act(() => {
      jest.advanceTimersByTime(theme.motion.toastVisible);
    });
    expect(screen.getByText('Removido')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Desfazer' }));
    expect(onPress).toHaveBeenCalled();
    expect(screen.queryByText('Removido')).not.toBeOnTheScreen();
  });

  it('useToast fora do provider falha com mensagem clara', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(renderUi(<Trigger options={[]} />)).rejects.toThrow(/ToastProvider/);
  });
});
