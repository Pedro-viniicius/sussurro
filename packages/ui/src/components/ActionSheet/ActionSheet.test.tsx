import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { useActionSheet } from './ActionSheet';
import { renderUi } from '../../test-utils/render';
import { Button } from '../Button/Button';

function Harness({ onReport, onBlock }: { onReport: () => void; onBlock: () => void }) {
  const menu = useActionSheet();
  return (
    <>
      <Text>Tela</Text>
      <Button
        label="Abrir menu"
        onPress={() => {
          menu.show({
            title: 'Publicação de @marinac',
            actions: [
              { label: 'Denunciar', onPress: onReport },
              { label: 'Bloquear', destructive: true, onPress: onBlock },
            ],
          });
        }}
      />
      {menu.element}
    </>
  );
}

describe('ActionSheet (D-UX14)', () => {
  it('abre com o título, as ações na ordem e "Cancelar"; a ação escolhida roda depois de fechar', async () => {
    const onReport = jest.fn();
    const onBlock = jest.fn();
    await renderUi(<Harness onReport={onReport} onBlock={onBlock} />);
    expect(screen.queryByRole('button', { name: 'Denunciar' })).not.toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: 'Abrir menu' }));
    expect(screen.getByRole('header', { name: 'Publicação de @marinac' })).toBeOnTheScreen();
    const labels = screen
      .getAllByRole('button')
      .map((node) => String(node.props.accessibilityLabel))
      .filter((label) => ['Denunciar', 'Bloquear', 'Cancelar'].includes(label));
    expect(labels).toEqual(['Denunciar', 'Bloquear', 'Cancelar']);

    await userEvent.press(screen.getByRole('button', { name: 'Bloquear' }));
    expect(screen.queryByRole('button', { name: 'Denunciar' })).not.toBeOnTheScreen();
    await waitFor(() => {
      expect(onBlock).toHaveBeenCalledTimes(1);
    });
    expect(onReport).not.toHaveBeenCalled();
  });

  it('"Cancelar" e o toque fora fecham sem executar nada', async () => {
    const onReport = jest.fn();
    const onBlock = jest.fn();
    await renderUi(<Harness onReport={onReport} onBlock={onBlock} />);
    await userEvent.press(screen.getByRole('button', { name: 'Abrir menu' }));
    await userEvent.press(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('button', { name: 'Denunciar' })).not.toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: 'Abrir menu' }));
    // O fundo é escondido do leitor de tela (o caminho acessível é "Cancelar").
    await userEvent.press(
      screen.getByTestId('action-sheet-backdrop', { includeHiddenElements: true }),
    );
    expect(screen.queryByRole('button', { name: 'Bloquear' })).not.toBeOnTheScreen();
    expect(onReport).not.toHaveBeenCalled();
    expect(onBlock).not.toHaveBeenCalled();
  });
});
