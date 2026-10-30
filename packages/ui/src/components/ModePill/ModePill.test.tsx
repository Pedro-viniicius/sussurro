import { screen, userEvent } from '@testing-library/react-native';

import { ModePill } from './ModePill';
import { renderUi } from '../../test-utils/render';

describe('ModePill (p18)', () => {
  it('FOTO/TEXTO/REEL; troca de modo; REEL desabilitado até a Fase 5', async () => {
    const onChange = jest.fn();
    await renderUi(<ModePill value="photo" onChange={onChange} disabled={['reel']} />);
    expect(screen.getByRole('tab', { name: 'Foto' })).toBeSelected();
    expect(screen.getByText('TEXTO')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('tab', { name: 'Texto' }));
    expect(onChange).toHaveBeenCalledWith('text');
    expect(screen.getByRole('tab', { name: 'Reel' })).toBeDisabled();
    await userEvent.press(screen.getByRole('tab', { name: 'Reel' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
