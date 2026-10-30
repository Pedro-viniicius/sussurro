import { screen, userEvent } from '@testing-library/react-native';

import { BottomTabBar } from './BottomTabBar';
import { renderUi } from '../../test-utils/render';

const avatar = { handle: 'helena', name: 'Helena Souza' };

describe('BottomTabBar', () => {
  it('CA8 (0.8): pessoal na ordem Início, Pesquisar, Criar, Conectar, Perfil', async () => {
    await renderUi(
      <BottomTabBar variant="personal" active="home" avatar={avatar} onPress={jest.fn()} />,
    );
    expect(screen.getByTestId('bottom-tab-bar')).toHaveProp('accessibilityRole', 'tablist');
    expect(screen.getAllByRole('tab').map((tab) => tab.props.accessibilityLabel)).toEqual([
      'Início',
      'Pesquisar',
      'Criar publicação',
      'Conectar',
      'Perfil',
    ]);
    expect(screen.getByRole('tab', { name: 'Início' })).toBeSelected();
    // Início ativo usa a casa preenchida.
    expect(screen.getByTestId('icon-house-fill', { includeHiddenElements: true })).toBeTruthy();
  });

  it('CA8 (0.8): criador na ordem Notificações, Criar, Perfil', async () => {
    await renderUi(
      <BottomTabBar variant="creator" active="profile" avatar={avatar} onPress={jest.fn()} />,
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.props.accessibilityLabel)).toEqual([
      'Notificações',
      'Criar publicação',
      'Perfil',
    ]);
    expect(screen.getByRole('tab', { name: 'Perfil' })).toBeSelected();
  });

  it('notificações não lidas: ponto azul e rótulo "há novidades"', async () => {
    await renderUi(
      <BottomTabBar
        variant="creator"
        active="profile"
        avatar={avatar}
        hasUnread
        onPress={jest.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Notificações, há novidades' })).toBeOnTheScreen();
    expect(
      screen.getByTestId('bottom-tab-bar-unread', { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it('tocar numa aba avisa a chave', async () => {
    const onPress = jest.fn();
    await renderUi(
      <BottomTabBar variant="personal" active="home" avatar={avatar} onPress={onPress} />,
    );
    await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
    expect(onPress).toHaveBeenCalledWith('connect');
  });
});
