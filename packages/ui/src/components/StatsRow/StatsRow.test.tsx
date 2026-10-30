import { screen, userEvent } from '@testing-library/react-native';

import { formatStatCount, STAT_LABELS, StatsRow } from './StatsRow';
import { renderUi } from '../../test-utils/render';

describe('formatStatCount', () => {
  it.each([
    [0, '0'],
    [5, '5'],
    [999, '999'],
    [8903, '8.903'],
    [9999, '9.999'],
    [10_000, '10 mil'],
    [12_400, '12,4 mil'],
    [12_499, '12,4 mil'],
    [999_999, '999,9 mil'],
    [1_200_000, '1,2 mi'],
    [3_000_000, '3 mi'],
  ])('CA6 (0.8): %i → "%s"', (value, expected) => {
    expect(formatStatCount(value)).toBe(expected);
  });
});

describe('StatsRow', () => {
  it('CA6 (0.8): singular e plural', async () => {
    await renderUi(
      <StatsRow
        items={[
          { value: 1, label: STAT_LABELS.posts },
          { value: 2, label: STAT_LABELS.connections },
          { value: 12_400, label: STAT_LABELS.creators },
        ]}
      />,
    );
    expect(screen.getByText('publicação')).toBeOnTheScreen();
    expect(screen.getByText('conexões')).toBeOnTheScreen();
    expect(screen.getByText('12,4 mil')).toBeOnTheScreen();
    expect(screen.getByLabelText('1 publicação')).toBeOnTheScreen();
  });

  it('itens tocáveis (só do dono) são botões com dica; os outros não', async () => {
    const onPress = jest.fn();
    await renderUi(
      <StatsRow
        items={[
          { value: 5, label: STAT_LABELS.posts },
          { value: 8, label: STAT_LABELS.connections, onPress },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: '8 conexões' });
    expect(button.props.accessibilityHint).toBe('Abre a lista, visível só para você');
    expect(screen.queryByRole('button', { name: '5 publicações' })).not.toBeOnTheScreen();
    await userEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
