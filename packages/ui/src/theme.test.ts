import { brandColorTokens, theme } from './theme';

// Trava os tokens do PO (briefing.md §6). Se este teste falhar, alguém mudou uma cor da marca:
// isso só pode acontecer com decisão do PO (teste-sentinela F0-Q-07).
describe('theme', () => {
  it('CA1 (0.8): as 9 cores do briefing são exatamente as da especificação', () => {
    expect({
      blue: theme.colors.blue,
      blueMid: theme.colors.blueMid,
      blueMist: theme.colors.blueMist,
      blueLight: theme.colors.blueLight,
      black: theme.colors.black,
      grey: theme.colors.grey,
      greySoft: theme.colors.greySoft,
      border: theme.colors.border,
      white: theme.colors.white,
    }).toEqual({
      blue: '#0066FF',
      blueMid: '#4D94FF',
      blueMist: '#B3D1FF',
      blueLight: '#E5EFFF',
      black: '#000000',
      grey: '#737373',
      greySoft: '#EFEFEF',
      border: '#DBDBDB',
      white: '#FFFFFF',
    });
    expect(brandColorTokens).toHaveLength(9);
  });

  it('CA1 (0.8): as extensões são as do ux.md §6.2', () => {
    expect(theme.colors).toMatchObject({
      bluePressed: '#0052CC',
      greyStrong: '#666666',
      field: '#FAFAFA',
      ink: '#262626',
      inkMuted: '#A8A8A8',
      danger: '#D32F2F',
      overlay: 'rgba(0,0,0,0.4)',
      mediaChip: 'rgba(0,0,0,0.7)',
    });
  });

  it('pastéis do avatar na ordem do ux.md §6.3', () => {
    expect(theme.avatarPalette.map((p) => p.color)).toEqual([
      '#D9D1FF',
      '#C2EFD4',
      '#FFD3BF',
      '#B5E8F7',
      '#C4D6FF',
      '#FFE3A3',
    ]);
  });

  it('cada peso de Inter tem família própria e o Bricolage é só do wordmark', () => {
    expect(theme.fonts).toEqual({
      regular: 'Inter_400Regular',
      semibold: 'Inter_600SemiBold',
      bold: 'Inter_700Bold',
      wordmark: 'BricolageGrotesque_800ExtraBold',
    });
    for (const style of Object.values(theme.type)) {
      expect(style.fontFamily).not.toBe(theme.fonts.wordmark);
    }
  });

  it('tipografia, raios e espaçamentos do ux.md', () => {
    expect(theme.type.body).toMatchObject({ fontSize: 15, lineHeight: 22 });
    expect(theme.type.titleLg).toMatchObject({ fontSize: 20, letterSpacing: -0.2 });
    expect(theme.radius).toMatchObject({ md: 10, lg: 12, sheet: 20 });
    expect(Object.values(theme.space)).toEqual([0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
    expect(theme.layout.hitMin).toBe(44);
  });
});
