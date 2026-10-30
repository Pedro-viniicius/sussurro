import { screen } from '@testing-library/react-native';

import { PairAvatars } from './PairAvatars';
import { renderUi } from '../../test-utils/render';

const HELENA = { handle: 'helena', name: 'Helena Souza' };
const CAIO = { handle: 'caio.r', name: 'Caio Ribeiro' };
const hidden = { includeHiddenElements: true };

describe('PairAvatars (p13/p14, ux.md §6.14)', () => {
  it('aguardando: dois avatares com o tracejado azul; decorativo', async () => {
    await renderUi(<PairAvatars left={HELENA} right={CAIO} state="waiting" />);
    expect(screen.getByTestId('pair-avatars-azul', hidden)).toBeTruthy();
    expect(screen.getByText('HS', hidden)).toBeTruthy();
    expect(screen.getByText('CR', hidden)).toBeTruthy();
    expect(screen.queryByRole('image')).not.toBeOnTheScreen();
  });

  it('não confirmado: tracejado cinza', async () => {
    await renderUi(<PairAvatars left={HELENA} right={CAIO} state="notConfirmed" />);
    expect(screen.getByTestId('pair-avatars-cinza', hidden)).toBeTruthy();
  });

  it('conectados: sobrepostos com o selo ✓', async () => {
    await renderUi(<PairAvatars left={HELENA} right={CAIO} state="connected" />);
    expect(screen.getByTestId('pair-avatars-selo', hidden)).toBeTruthy();
  });
});
