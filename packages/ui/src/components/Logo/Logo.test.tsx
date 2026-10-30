import { screen } from '@testing-library/react-native';
import { processColor } from 'react-native';

import { Logo } from './Logo';
import { renderUi } from '../../test-utils/render';

// react-native-svg guarda a cor já processada: { type: 0, payload: ARGB }.
const svgColor = (hex: string) => ({ type: 0, payload: processColor(hex) });

// Valores literais do briefing.md §6 / ux.md §6.12, de propósito sem importar `geometry.ts`.
const ARC_1 = 'M42.34 18.24 A11 11 0 1 0 24.22 29.78';
const ARC_2 = 'M21.66 45.76 A11 11 0 1 0 39.78 34.22';

describe('Logo', () => {
  it('CA (0.8): geometria exata do briefing (viewBox 64, stroke 8, pontas redondas, ponto r=3)', async () => {
    await renderUi(<Logo />);
    const mark = screen.getByTestId('logo-mark').props;
    expect([mark.minX, mark.minY, mark.vbWidth, mark.vbHeight]).toEqual([0, 0, 64, 64]);

    for (const [id, d] of [
      ['logo-arc-1', ARC_1],
      ['logo-arc-2', ARC_2],
    ] as const) {
      const arc = screen.getByTestId(id).props;
      expect(arc.d).toBe(d);
      expect(arc.strokeWidth).toBe(8);
      expect(arc.strokeLinecap).toBe(1); // round
      expect(arc.fill).toBeNull(); // fill="none"
    }

    const dot = screen.getByTestId('logo-dot').props;
    expect([dot.cx, dot.cy, dot.r]).toEqual([32, 32, 3]);
  });

  it('tom padrão: arcos #0066FF e #4D94FF, ponto preto', async () => {
    await renderUi(<Logo />);
    expect(screen.getByTestId('logo-arc-1').props.stroke).toEqual(svgColor('#0066FF'));
    expect(screen.getByTestId('logo-arc-2').props.stroke).toEqual(svgColor('#4D94FF'));
    expect(screen.getByTestId('logo-dot').props.fill).toEqual(svgColor('#000000'));
  });

  it('tom onBrand (sobre azul ou preto): arcos branco e #B3D1FF, ponto branco', async () => {
    await renderUi(<Logo tone="onBrand" />);
    expect(screen.getByTestId('logo-arc-1').props.stroke).toEqual(svgColor('#FFFFFF'));
    expect(screen.getByTestId('logo-arc-2').props.stroke).toEqual(svgColor('#B3D1FF'));
    expect(screen.getByTestId('logo-dot').props.fill).toEqual(svgColor('#FFFFFF'));
  });

  it('tamanho mínimo de 16 pt e rótulo acessível', async () => {
    await renderUi(<Logo size={8} />);
    const mark = screen.getByTestId('logo-mark').props;
    expect([mark.bbWidth, mark.bbHeight]).toEqual([16, 16]);
    expect(screen.getByLabelText('Sussurro')).toBeOnTheScreen();
  });

  it('lockup mostra o wordmark "sussurro"', async () => {
    await renderUi(<Logo variant="lockup" />);
    expect(screen.getByTestId('logo-wordmark')).toHaveTextContent('sussurro');
  });
});
