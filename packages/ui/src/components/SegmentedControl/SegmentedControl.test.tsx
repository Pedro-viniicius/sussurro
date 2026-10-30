import { screen, userEvent } from '@testing-library/react-native';

import { SegmentedControl } from './SegmentedControl';
import { renderUi } from '../../test-utils/render';

const OPTIONS = [
  { key: 'ble', label: 'Bluetooth' },
  { key: 'qr', label: 'QR code' },
] as const;

describe('SegmentedControl (ux.md §6.14, D3)', () => {
  it('grupo de opções com a escolhida marcada; tocar na outra avisa', async () => {
    const onChange = jest.fn();
    await renderUi(
      <SegmentedControl
        options={OPTIONS}
        value="ble"
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
    expect(screen.getByRole('radio', { name: 'Bluetooth' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'QR code' })).not.toBeChecked();

    await userEvent.press(screen.getByRole('radio', { name: 'QR code' }));
    expect(onChange).toHaveBeenCalledWith('qr');
    // Tocar na já escolhida não avisa de novo.
    await userEvent.press(screen.getByRole('radio', { name: 'Bluetooth' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
