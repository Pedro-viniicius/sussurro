import { act, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { TOUCH_HINT_DEMO_MS, TouchHint, touchHintSize } from './TouchHint';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

const hidden = { includeHiddenElements: true } as const;

function opacityOf(testID: string): unknown {
  const style = StyleSheet.flatten(screen.getByTestId(testID, hidden).props.style) as {
    opacity?: unknown;
  };
  return style.opacity;
}

afterEach(() => {
  jest.useRealTimers();
});

describe('TouchHint (ux.md §11.7)', () => {
  it('decorativa: some do leitor de tela e não recebe toque; 240 × 216 e 200 × 180 no compacto', async () => {
    await renderUi(<TouchHint pose="demo" />);
    const root = screen.getByTestId('touch-hint', hidden);
    expect(root).toHaveProp('accessibilityElementsHidden', true);
    expect(root).toHaveProp('importantForAccessibility', 'no-hide-descendants');
    expect(root).toHaveProp('pointerEvents', 'none');
    // O logo do selo também não aparece para o leitor de tela.
    expect(screen.queryByRole('image', { name: 'Sussurro' })).toBeNull();
    expect(touchHintSize()).toEqual({ width: 240, height: 216 });
    expect(touchHintSize(true)).toEqual({ width: 200, height: 180 });
  });

  it('11.8 / WCAG 2.2.2: com "Reduzir movimento" fica parada na pose "afastados", com as setas e sem o selo', async () => {
    await renderUi(<TouchHint pose="demo" />, { reduceMotion: true });
    expect(screen.getByTestId('touch-hint-estatico', hidden)).toBeTruthy();
    expect(screen.queryByTestId('touch-hint-animado', hidden)).toBeNull();
    expect(opacityOf('touch-hint-setas')).toBe(1);
    expect(opacityOf('touch-hint-selo')).toBe(0);
  });

  it('WCAG 2.2.2: a demonstração tem 2 ciclos de motion.touchCycle (4,8 s, menos de 5 s)', () => {
    expect(theme.motion.touchCycle).toBe(2400);
    expect(TOUCH_HINT_DEMO_MS).toBe(4800);
    expect(TOUCH_HINT_DEMO_MS).toBeLessThan(5000);
  });

  it('demonstração: começa sem as setas, termina e para na pose "afastados" (não volta a rodar)', async () => {
    jest.useFakeTimers();
    await renderUi(<TouchHint pose="demo" />, { reduceMotion: false });
    expect(screen.getByTestId('touch-hint-animado', hidden)).toBeTruthy();
    // As setas só aparecem em repouso.
    expect(opacityOf('touch-hint-setas')).toBe(0);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(TOUCH_HINT_DEMO_MS + 200);
    });
    expect(screen.queryByTestId('touch-hint-animado', hidden)).toBeNull();
    expect(screen.getByTestId('touch-hint-repouso', hidden)).toBeTruthy();
    // Parada: o tempo passa e ela não recomeça sozinha.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByTestId('touch-hint-repouso', hidden)).toBeTruthy();
  });

  it('"quase": selo a 40% e sem sombra; "encostados": selo com sombra; sem setas nos dois', async () => {
    jest.useFakeTimers();
    const view = await renderUi(<TouchHint pose="approaching" />, { reduceMotion: false });
    expect(screen.getByTestId('touch-hint-approaching', hidden)).toBeTruthy();
    expect(opacityOf('touch-hint-selo')).toBe(0.4);
    expect(opacityOf('touch-hint-setas')).toBe(0);
    expect(
      StyleSheet.flatten(screen.getByTestId('touch-hint-selo', hidden).props.style),
    ).not.toHaveProperty('boxShadow');

    await view.rerender(<TouchHint pose="touching" />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(theme.motion.heart + 50);
    });
    expect(screen.getByTestId('touch-hint-touching', hidden)).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('touch-hint-selo', hidden).props.style)).toEqual(
      expect.objectContaining({ boxShadow: theme.shadow.sm }),
    );
  });

  it('montada direto em "encostados": selo inteiro, sem setas', async () => {
    await renderUi(<TouchHint pose="touching" compact />, { reduceMotion: true });
    expect(screen.getByTestId('touch-hint-estatico', hidden)).toBeTruthy();
    expect(opacityOf('touch-hint-selo')).toBe(1);
    expect(opacityOf('touch-hint-setas')).toBe(0);
  });

  it('a demonstração interrompida (outra pose) não volta a rodar sem montar de novo', async () => {
    jest.useFakeTimers();
    const view = await renderUi(<TouchHint pose="demo" />, { reduceMotion: false });
    expect(screen.getByTestId('touch-hint-animado', hidden)).toBeTruthy();
    await view.rerender(<TouchHint pose="approaching" />);
    await view.rerender(<TouchHint pose="demo" />);
    expect(screen.queryByTestId('touch-hint-animado', hidden)).toBeNull();
    expect(screen.getByTestId('touch-hint-repouso', hidden)).toBeTruthy();
  });
});
