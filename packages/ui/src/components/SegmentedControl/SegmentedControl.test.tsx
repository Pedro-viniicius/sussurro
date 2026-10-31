import { screen, userEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { SegmentedControl } from './SegmentedControl';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

const OPTIONS = [
  { key: 'touch', label: 'Encostar' },
  { key: 'qr', label: 'QR code' },
] as const;

describe('SegmentedControl (ux.md §6.14 e §11.11, D3 revisto)', () => {
  it('grupo de opções com a escolhida marcada; tocar na outra avisa', async () => {
    const onChange = jest.fn();
    await renderUi(
      <SegmentedControl
        options={OPTIONS}
        value="touch"
        onChange={onChange}
        accessibilityLabel="Como conectar"
      />,
    );
    // O grupo não é um elemento único do leitor de tela: cada opção é focável.
    expect(screen.getByTestId('segmented-control')).toHaveProp('accessibilityRole', 'radiogroup');
    expect(screen.getByTestId('segmented-control')).toHaveProp(
      'accessibilityLabel',
      'Como conectar',
    );
    expect(screen.getByRole('radio', { name: 'Encostar' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'QR code' })).not.toBeChecked();

    await userEvent.press(screen.getByRole('radio', { name: 'QR code' }));
    expect(onChange).toHaveBeenCalledWith('qr');
    // Tocar na já escolhida não avisa de novo.
    await userEvent.press(screen.getByRole('radio', { name: 'Encostar' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('11.8: 44 de altura (segmentos de 38), pela regra hitMin', async () => {
    await renderUi(
      <SegmentedControl
        options={OPTIONS}
        value="touch"
        onChange={jest.fn()}
        accessibilityLabel="Como conectar"
      />,
    );
    const style = (testID: string) =>
      StyleSheet.flatten(screen.getByTestId(testID).props.style) as { minHeight?: number };
    expect(style('segmented-control').minHeight).toBe(theme.layout.hitMin);
    expect(style('segmented-control-qr').minHeight).toBe(38);
  });
});
