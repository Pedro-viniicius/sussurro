import { screen, userEvent } from '@testing-library/react-native';
import { Text } from 'react-native';

import { Radar } from './Radar';
import { renderUi } from '../../test-utils/render';

describe('Radar (ux.md §6.14 e §6.10)', () => {
  it('idle (p10): botão "Procurar por perto"', async () => {
    const onPress = jest.fn();
    await renderUi(<Radar variant="idle" onPress={onPress} />);
    await userEvent.press(screen.getByRole('button', { name: 'Procurar por perto' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('4.4 CA9: procurando com "Reduzir movimento" → radar estático (sem anéis animados)', async () => {
    await renderUi(<Radar variant="searching" center={<Text>HS</Text>} />, { reduceMotion: true });
    expect(screen.getByTestId('radar-estatico', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId('radar-animado', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByText('HS')).toBeOnTheScreen();
  });

  it('procurando sem "Reduzir movimento" → anéis animados', async () => {
    await renderUi(<Radar variant="searching" center={<Text>HS</Text>} />, {
      reduceMotion: false,
    });
    expect(screen.getByTestId('radar-animado', { includeHiddenElements: true })).toBeTruthy();
  });
});
