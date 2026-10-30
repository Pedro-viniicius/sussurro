import { screen, userEvent } from '@testing-library/react-native';

import { PhotoTile } from './PhotoTile';
import { renderUi } from '../../test-utils/render';

const IMAGE = { key: 'm1', uri: 'https://cdn.teste/t1.jpg' };

describe('PhotoTile (grade do perfil)', () => {
  it('3:4, ícone de várias fotos e toque', async () => {
    const onPress = jest.fn();
    await renderUi(
      <PhotoTile image={IMAGE} width={129} multiple onPress={onPress} accessibilityLabel="Foto" />,
    );
    expect(screen.getByRole('button', { name: 'Foto' })).toHaveStyle({ width: 129, height: 172 });
    expect(screen.getByTestId('icon-copy', { includeHiddenElements: true })).toBeTruthy();
    await userEvent.press(screen.getByRole('button', { name: 'Foto' }));
    expect(onPress).toHaveBeenCalled();
  });

  it('MID-09: estados "Processando" e "Falhou" (só o dono vê)', async () => {
    await renderUi(
      <PhotoTile image={IMAGE} width={100} status="processing" accessibilityLabel="Foto" />,
    );
    expect(screen.getByText('Processando')).toBeOnTheScreen();
    expect(screen.getByLabelText('Foto, processando')).toBeOnTheScreen();
    await renderUi(
      <PhotoTile image={IMAGE} width={100} status="failed" accessibilityLabel="Foto" />,
    );
    expect(screen.getByText('Falhou')).toBeOnTheScreen();
    expect(screen.getByLabelText('Foto, não foi possível publicar')).toBeOnTheScreen();
  });
});
