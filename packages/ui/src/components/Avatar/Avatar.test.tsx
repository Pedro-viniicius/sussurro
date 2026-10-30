import { fireEvent, screen } from '@testing-library/react-native';

import { Avatar } from './Avatar';
import { avatarColor } from './avatar-color';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

describe('Avatar', () => {
  it('sem foto: iniciais sobre o pastel da semente', async () => {
    await renderUi(<Avatar handle="erica" name="Érica Lima" seed="user-1" size={44} />);
    expect(screen.getByText('ÉL')).toBeOnTheScreen();
    expect(screen.getByTestId('avatar-circle')).toHaveStyle({
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: avatarColor('user-1').color,
    });
    expect(screen.getByText('ÉL')).toHaveStyle({ fontSize: 16 });
  });

  it('CA4 (0.8): a mesma semente dá a mesma cor em renders diferentes', async () => {
    await renderUi(
      <>
        <Avatar handle="a" seed="0190f3c4" testID="a1" />
        <Avatar handle="b" seed="0190f3c4" testID="a2" />
      </>,
    );
    const color = (id: string) =>
      (screen.getByTestId(`${id}-circle`).props.style as { backgroundColor: string }[])[1]
        ?.backgroundColor;
    expect(color('a1')).toBe(color('a2'));
  });

  it('isolado é uma imagem com rótulo "Foto de perfil de @handle"', async () => {
    await renderUi(<Avatar handle="marinac" name="Marina Costa" />);
    expect(screen.getByRole('image', { name: 'Foto de perfil de @marinac' })).toBeOnTheScreen();
  });

  it('decorativo some do leitor de tela', async () => {
    await renderUi(<Avatar handle="marinac" decorative />);
    expect(screen.queryByRole('image')).not.toBeOnTheScreen();
  });

  it('com foto: mostra a imagem; se falhar, fica nas iniciais', async () => {
    await renderUi(<Avatar handle="marinac" name="Marina Costa" uri="https://x/y.jpg" />);
    const photo = screen.getByTestId('avatar-photo');
    expect(photo.props.source).toEqual({ uri: 'https://x/y.jpg' });
    expect(screen.getByText('MC')).toBeOnTheScreen();
    await fireEvent(photo, 'error');
    expect(screen.queryByTestId('avatar-photo')).not.toBeOnTheScreen();
    expect(screen.getByText('MC')).toBeOnTheScreen();
  });

  it('agregado "+N" usa blueLight e anuncia "N novas pessoas"', async () => {
    await renderUi(<Avatar handle="x" count={2} />);
    expect(screen.getByText('+2')).toBeOnTheScreen();
    expect(screen.getByRole('image', { name: '2 novas pessoas' })).toBeOnTheScreen();
    expect(screen.getByTestId('avatar-circle')).toHaveStyle({
      backgroundColor: theme.colors.blueLight,
    });
  });

  it('agregado com `countLabel`: mostra o rótulo ("99+") e anuncia o número real', async () => {
    await renderUi(<Avatar handle="" count={150} countLabel="99+" />);
    expect(screen.getByText('99+')).toBeOnTheScreen();
    expect(screen.getByRole('image', { name: '150 novas pessoas' })).toBeOnTheScreen();
  });

  it('com anel: folga 2 + traço 1,5 preto (24 → 31)', async () => {
    await renderUi(<Avatar handle="marinac" size={24} ring />);
    expect(screen.getByTestId('avatar')).toHaveStyle({
      width: 31,
      height: 31,
      borderWidth: 1.5,
      borderColor: theme.colors.black,
    });
  });
});
