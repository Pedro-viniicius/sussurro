import { fireEvent, screen, userEvent } from '@testing-library/react-native';

import { NotificationRow, type NotificationTextSegment } from './NotificationRow';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

const LIKED: NotificationTextSegment[] = [
  { kind: 'handle', value: 'marinac' },
  { kind: 'text', value: ' curtiu sua foto.' },
];

const COMMENTED: NotificationTextSegment[] = [
  { kind: 'handle', value: 'lucasf' },
  { kind: 'text', value: ' comentou na sua foto: ' },
  { kind: 'quote', value: '“Que luz bonita!”' },
];

/** O formato do `notificationTextParts` para os seguidores agregados (p21). */
const FOLLOWERS: NotificationTextSegment[] = [
  { kind: 'count', value: '3 novas pessoas' },
  { kind: 'text', value: ' começaram a seguir você.' },
];

describe('NotificationRow (p09, p21; ux.md §6.14)', () => {
  it('texto com o @ em 600, o tempo inline em caption grey e a miniatura do post', async () => {
    await renderUi(
      <NotificationRow
        parts={COMMENTED}
        time="1 h"
        avatar={{ kind: 'account', handle: 'lucasf', name: 'Lucas F' }}
        thumbnail={{ key: 'post-1', uri: 'https://cdn.teste/p1.jpg' }}
        accessibilityLabel="lucasf comentou na sua foto: “Que luz bonita!” há 1 hora"
        onPress={jest.fn()}
      />,
    );
    expect(screen.getByText('lucasf')).toHaveStyle({ fontFamily: theme.fonts.semibold });
    expect(screen.getByText('“Que luz bonita!”')).toHaveStyle({ fontFamily: theme.fonts.regular });
    expect(screen.getByText(' 1 h')).toHaveStyle({ color: theme.colors.grey, fontSize: 13 });
    expect(screen.getByTestId('notification-row-thumb')).toHaveStyle({
      width: 44,
      height: 44,
      borderRadius: theme.radius.sm,
    });
    expect(screen.getByText('LF', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('o toque na linha abre o post; o @ tocável abre o perfil sem abrir o post', async () => {
    const onPress = jest.fn();
    const onPressHandle = jest.fn();
    await renderUi(
      <NotificationRow
        parts={LIKED}
        time="20 min"
        avatar={{ kind: 'account', handle: 'marinac' }}
        accessibilityLabel="marinac curtiu sua foto. há 20 minutos"
        onPress={onPress}
        onPressHandle={onPressHandle}
        handleActionLabel="Abrir o perfil de @marinac"
      />,
    );
    await userEvent.press(screen.getByText('marinac'));
    expect(onPressHandle).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
    await userEvent.press(screen.getByRole('button', { name: /curtiu sua foto/ }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('D11/A-07: sem onPressHandle o @ é só texto em 600 (não tocável) e sem ação de perfil', async () => {
    const onPress = jest.fn();
    await renderUi(
      <NotificationRow
        parts={LIKED}
        time="20 min"
        avatar={{ kind: 'account', handle: 'marinac' }}
        accessibilityLabel="marinac curtiu sua foto. há 20 minutos"
        onPress={onPress}
      />,
    );
    const handle = screen.getByText('marinac');
    expect(handle.props.onPress).toBeUndefined();
    expect(handle).toHaveStyle({ fontFamily: theme.fonts.semibold });
    expect(screen.getByRole('button').props.accessibilityActions).toBeUndefined();
  });

  it('leitor de tela: a ação "Abrir o perfil" chama o @ e "activate" abre o post', async () => {
    const onPress = jest.fn();
    const onPressHandle = jest.fn();
    await renderUi(
      <NotificationRow
        parts={LIKED}
        time="20 min"
        avatar={{ kind: 'account', handle: 'marinac' }}
        accessibilityLabel="marinac curtiu sua foto. há 20 minutos"
        onPress={onPress}
        onPressHandle={onPressHandle}
        handleActionLabel="Abrir o perfil de @marinac"
      />,
    );
    const row = screen.getByRole('button', { name: /curtiu sua foto/ });
    expect(row.props.accessibilityActions).toEqual([
      { name: 'activate' },
      { name: 'profile', label: 'Abrir o perfil de @marinac' },
    ]);
    await fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'profile' } });
    expect(onPressHandle).toHaveBeenCalledTimes(1);
    await fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('NOT-05: seguidores agregados com o avatar "+N" em blueLight, sem ninguém nomeado e sem toque', async () => {
    await renderUi(
      <NotificationRow
        parts={FOLLOWERS}
        time="10 min"
        avatar={{ kind: 'aggregate', count: 3, label: '+3' }}
        accessibilityLabel="3 novas pessoas começaram a seguir você. há 10 minutos"
      />,
    );
    expect(screen.getByText('+3', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(
      screen.getByTestId('notification-row-avatar-circle', { includeHiddenElements: true }),
    ).toHaveStyle({
      backgroundColor: theme.colors.blueLight,
    });
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('notification-row-thumb')).not.toBeOnTheScreen();
    expect(
      screen.getByLabelText('3 novas pessoas começaram a seguir você. há 10 minutos'),
    ).toBeOnTheScreen();
  });

  it('NOT-05 (p21): o "N novas pessoas" em 600, como o @, mas nunca tocável e sem o testID do @', async () => {
    const onPressHandle = jest.fn();
    await renderUi(
      <NotificationRow
        parts={FOLLOWERS}
        time="10 min"
        avatar={{ kind: 'aggregate', count: 3, label: '+3' }}
        accessibilityLabel="3 novas pessoas começaram a seguir você. há 10 minutos"
        // Mesmo que alguém passe o toque do @, o pedaço `count` não o usa.
        onPressHandle={onPressHandle}
        testID="seguidores"
      />,
    );
    const count = screen.getByText('3 novas pessoas');
    expect(count).toHaveStyle({ fontFamily: theme.fonts.semibold });
    expect(count.props.onPress).toBeUndefined();
    expect(screen.getByTestId('seguidores-count')).toBe(count);
    expect(screen.queryByTestId('seguidores-handle')).not.toBeOnTheScreen();
    expect(screen.getByText('começaram a seguir você.')).toHaveStyle({
      fontFamily: theme.fonts.regular,
    });
    await userEvent.press(count);
    expect(onPressHandle).not.toHaveBeenCalled();
  });

  it('acima de 99 seguidores usa o rótulo do app ("99+")', async () => {
    await renderUi(
      <NotificationRow
        parts={[
          { kind: 'count', value: '150 novas pessoas' },
          { kind: 'text', value: ' começaram a seguir você.' },
        ]}
        time="agora"
        avatar={{ kind: 'aggregate', count: 150, label: '99+' }}
        accessibilityLabel="150 novas pessoas começaram a seguir você. agora"
      />,
    );
    expect(screen.getByText('99+', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.queryByText('+150', { includeHiddenElements: true })).not.toBeOnTheScreen();
  });

  it('não lida: ponto azul 8 à esquerda da miniatura; lida: sem ponto', async () => {
    const { rerender } = await renderUi(
      <NotificationRow
        parts={LIKED}
        time="20 min"
        avatar={{ kind: 'account', handle: 'marinac' }}
        thumbnail={{ key: 'p', uri: 'https://cdn.teste/p.jpg' }}
        unread
        accessibilityLabel="marinac curtiu sua foto. há 20 minutos, nova"
      />,
    );
    expect(screen.getByTestId('notification-row-unread')).toHaveStyle({
      width: 8,
      height: 8,
      backgroundColor: theme.colors.blue,
    });
    await rerender(
      <NotificationRow
        parts={LIKED}
        time="20 min"
        avatar={{ kind: 'account', handle: 'marinac' }}
        accessibilityLabel="marinac curtiu sua foto. há 20 minutos"
      />,
    );
    expect(screen.queryByTestId('notification-row-unread')).not.toBeOnTheScreen();
  });
});
