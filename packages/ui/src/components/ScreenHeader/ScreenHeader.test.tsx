import { screen, userEvent } from '@testing-library/react-native';

import { ScreenHeader } from './ScreenHeader';
import { renderUi } from '../../test-utils/render';
import { OfflineBanner } from '../OfflineBanner/OfflineBanner';

describe('ScreenHeader', () => {
  it('back: botão Voltar e título como cabeçalho', async () => {
    const onBack = jest.fn();
    await renderUi(<ScreenHeader variant="back" title="Conta" onBack={onBack} />);
    expect(screen.getByRole('header', { name: 'Conta' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('modal: ação à esquerda e à direita; a da direita pode ficar desabilitada', async () => {
    const cancel = jest.fn();
    const done = jest.fn();
    await renderUi(
      <ScreenHeader
        variant="modal"
        title="Editar perfil"
        left={{ label: 'Cancelar', onPress: cancel }}
        right={{ label: 'Concluir', onPress: done, primary: true, disabled: true }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Concluir' })).toBeDisabled();
    await userEvent.press(screen.getByRole('button', { name: 'Concluir' }));
    expect(done).not.toHaveBeenCalled();
    await userEvent.press(screen.getByRole('button', { name: 'Cancelar' }));
    expect(cancel).toHaveBeenCalled();
  });
});

describe('OfflineBanner (ux.md §5.4)', () => {
  it('mostra "Sem internet" e "Conectado" como alerta', async () => {
    const { rerender } = await renderUi(<OfflineBanner status="offline" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Sem internet');
    await rerender(<OfflineBanner status="back" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Conectado');
  });
});
