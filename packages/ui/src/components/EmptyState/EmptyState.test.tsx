import { screen, userEvent } from '@testing-library/react-native';
import { createRef } from 'react';
import type { ViewInstance } from 'react-native';

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

  it('ux.md §11.15: com titleRef, o título fica num cabeçalho acessível que recebe a ref (para o foco); sem ele, nada muda', async () => {
    const titleRef = createRef<ViewInstance>();
    const { rerender } = await renderUi(
      <EmptyState
        icon="bluetooth-off"
        title="O Bluetooth está desligado"
        titleRef={titleRef}
        testID="bt-desligado"
      />,
    );
    const header = screen.getByRole('header', { name: 'O Bluetooth está desligado' });
    expect(header.props.testID).toBe('bt-desligado-titulo');
    expect(titleRef.current).not.toBeNull();
    await rerender(
      <EmptyState icon="bluetooth-off" title="O Bluetooth está desligado" testID="bt-desligado" />,
    );
    expect(screen.getByRole('header', { name: 'O Bluetooth está desligado' })).toBeOnTheScreen();
    expect(screen.queryByTestId('bt-desligado-titulo')).toBeNull();
  });
});
