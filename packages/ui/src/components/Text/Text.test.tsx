import { screen } from '@testing-library/react-native';

import { Text } from './Text';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

describe('Text', () => {
  it('resolve família, tamanho e entrelinha pelo token (sem fontWeight solto)', async () => {
    await renderUi(<Text variant="bodyStrong">@marinac</Text>);
    const node = screen.getByText('@marinac');
    expect(node).toHaveStyle({
      fontFamily: 'Inter_600SemiBold',
      fontSize: 15,
      lineHeight: 22,
      color: theme.colors.black,
    });
    expect(node.props.maxFontSizeMultiplier).toBe(2);
  });

  it('aplica a cor do token e a escala simulada do catálogo', async () => {
    await renderUi(
      <Text variant="caption" color="grey">
        Há 18 minutos
      </Text>,
      { fontScale: 2 },
    );
    expect(screen.getByText('Há 18 minutos')).toHaveStyle({
      fontSize: 26,
      lineHeight: 36,
      color: theme.colors.grey,
    });
  });

  it('botões limitam a escala do sistema a 1,5', async () => {
    await renderUi(<Text variant="button">Entrar</Text>);
    expect(screen.getByText('Entrar').props.maxFontSizeMultiplier).toBe(1.5);
  });
});
