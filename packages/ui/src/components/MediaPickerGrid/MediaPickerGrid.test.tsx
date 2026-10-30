import { screen, userEvent } from '@testing-library/react-native';

import { MediaPickerGrid } from './MediaPickerGrid';
import { renderUi } from '../../test-utils/render';

const ITEMS = ['a', 'b', 'c'].map((key) => ({ key, uri: `file:///${key}.jpg` }));

describe('MediaPickerGrid (ux.md §6.14)', () => {
  it('numera a seleção na ordem e avisa quem foi tocado', async () => {
    const onToggle = jest.fn();
    const onAdd = jest.fn();
    await renderUi(
      <MediaPickerGrid
        items={ITEMS}
        selected={['c', 'a']}
        onToggle={onToggle}
        onAdd={onAdd}
        width={390}
      />,
    );
    expect(screen.getByRole('button', { name: 'Foto 3, 1ª selecionada' })).toBeSelected();
    expect(screen.getByRole('button', { name: 'Foto 1, 2ª selecionada' })).toBeSelected();
    expect(screen.getByRole('button', { name: 'Foto 2' })).not.toBeSelected();
    await userEvent.press(screen.getByRole('button', { name: 'Foto 2' }));
    expect(onToggle).toHaveBeenCalledWith('b');
    await userEvent.press(screen.getByRole('button', { name: 'Escolher fotos do aparelho' }));
    expect(onAdd).toHaveBeenCalled();
    // 4 colunas 1:1 com gap 2: (390 − 6) / 4 = 96.
    expect(screen.getByTestId('media-picker-item-0')).toHaveStyle({ width: 96, height: 96 });
  });
});
