import { screen } from '@testing-library/react-native';

import { CaughtUp, caughtUpMessage, caughtUpPeriod } from './CaughtUp';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

describe('caughtUpPeriod', () => {
  // Os períodos chegam prontos do `feedWindowLabel` de packages/shared (FEED-04).
  it.each([
    ['últimos 3 dias', 'dos últimos 3 dias'],
    ['últimos 2 dias', 'dos últimos 2 dias'],
    ['último dia', 'do último dia'],
    ['últimas 36 horas', 'das últimas 36 horas'],
    ['última hora', 'da última hora'],
  ])('CA7 (0.8): "%s" → "%s"', (label, expected) => {
    expect(caughtUpPeriod(label)).toBe(expected);
  });
});

describe('CaughtUp', () => {
  it.each([
    ['photo', 'todas as fotos'],
    ['text', 'todos os textos'],
    ['reel', 'todos os reels'],
  ] as const)('tipo %s fala de %s', (kind, expected) => {
    expect(caughtUpMessage(kind, 'últimos 3 dias')).toBe(
      `Você viu ${expected} dos últimos 3 dias de quem você conhece e segue.`,
    );
  });

  it('título, texto e círculo de contorno azul com check', async () => {
    await renderUi(<CaughtUp kind="photo" windowLabel="últimos 3 dias" />);
    expect(screen.getByText('Você está em dia')).toBeOnTheScreen();
    expect(screen.getByText(/dos últimos 3 dias/)).toBeOnTheScreen();
    expect(screen.getByTestId('icon-check', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByLabelText(/^Você está em dia\. Você viu todas as fotos/)).toBeOnTheScreen();
    expect(theme.colors.blue).toBe('#0066FF');
  });
});
