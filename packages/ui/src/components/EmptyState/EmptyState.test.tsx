import { screen, userEvent } from '@testing-library/react-native';

import { EmptyState } from './EmptyState';
import { renderUi } from '../../test-utils/render';

describe('EmptyState', () => {
  it('título como cabeçalho, descrição e ícone decorativo', async () => {
    await renderUi(
      <EmptyState
        icon="lock"
        title="Indisponível para criadores"
        description="Contas de criador não se conectam com outras pessoas."
      />,
    );
    expect(screen.getByRole('header', { name: 'Indisponível para criadores' })).toBeOnTheScreen();
    expect(screen.getByText(/não se conectam/)).toBeOnTheScreen();
    expect(screen.queryByRole('image')).not.toBeOnTheScreen();
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });

  it('ações primária e secundária (link) chamam os callbacks', async () => {
    const primary = jest.fn();
    const secondary = jest.fn();
    await renderUi(
      <EmptyState
        icon="wifi-off"
        title="Sem internet"
        primaryAction={{ label: 'Tentar de novo', onPress: primary }}
        secondaryAction={{ label: 'Voltar ao perfil', onPress: secondary }}
      />,
    );
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    await userEvent.press(screen.getByRole('button', { name: 'Voltar ao perfil' }));
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
  });
});
