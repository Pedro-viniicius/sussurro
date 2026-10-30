/**
 * Tokens do design system do Sussurro (ux.md §6, forma em §6.16).
 * As 9 cores do PO (briefing.md §6) são intocáveis: `theme.test.ts` trava os valores.
 */

/** Tokens de cor do PO (briefing.md §6), inalterados. */
const brandColors = {
  blue: '#0066FF',
  blueMid: '#4D94FF',
  blueMist: '#B3D1FF',
  blueLight: '#E5EFFF',
  black: '#000000',
  grey: '#737373',
  greySoft: '#EFEFEF',
  border: '#DBDBDB',
  white: '#FFFFFF',
} as const;

/** Extensões justificadas no ux.md §6.2 (contraste e estados). */
const extendedColors = {
  bluePressed: '#0052CC',
  greyStrong: '#666666',
  /** Fundo pressionado do botão secundário (ux.md §6.13 Button). */
  greySoftPressed: '#E0E0E0',
  field: '#FAFAFA',
  ink: '#262626',
  inkMuted: '#A8A8A8',
  danger: '#D32F2F',
  overlay: 'rgba(0,0,0,0.4)',
  mediaChip: 'rgba(0,0,0,0.7)',
  skeleton: '#EFEFEF',
} as const;

const colors = { ...brandColors, ...extendedColors } as const;

/** Fundos pastel do avatar sem foto, na ordem do índice FNV-1a (ux.md §6.3). */
const avatarPalette = [
  { name: 'lilac', color: '#D9D1FF' },
  { name: 'mint', color: '#C2EFD4' },
  { name: 'peach', color: '#FFD3BF' },
  { name: 'sky', color: '#B5E8F7' },
  { name: 'periwinkle', color: '#C4D6FF' },
  { name: 'butter', color: '#FFE3A3' },
] as const;

/**
 * Famílias por peso. No Android, `fontWeight` não escolhe o arquivo de uma fonte personalizada:
 * cada peso é uma família própria, carregada pelo app com estes nomes (ux.md §6.5).
 */
const fonts = {
  regular: 'Inter_400Regular',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  /** Somente o wordmark "sussurro" do Logo. Proibido em qualquer outro texto. */
  wordmark: 'BricolageGrotesque_800ExtraBold',
} as const;

interface TypeStyle {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  /** Limite da escala de fonte do sistema (ux.md §7.4). */
  maxFontSizeMultiplier: number;
}

const t = (
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
  maxFontSizeMultiplier: number,
  letterSpacing = 0,
): TypeStyle => ({ fontFamily, fontSize, lineHeight, letterSpacing, maxFontSizeMultiplier });

/** Escala tipográfica medida no protótipo (ux.md §6.4). */
const type = {
  titleLg: t(fonts.bold, 20, 26, 2, -0.2),
  titleMd: t(fonts.bold, 18, 24, 2),
  titleSm: t(fonts.bold, 16, 22, 2),
  stat: t(fonts.bold, 17, 22, 2),
  bodyLg: t(fonts.regular, 16, 22, 2),
  body: t(fonts.regular, 15, 22, 2),
  bodyStrong: t(fonts.semibold, 15, 22, 2),
  bodySm: t(fonts.regular, 14, 20, 2),
  bodySmStrong: t(fonts.semibold, 14, 20, 2),
  caption: t(fonts.regular, 13, 18, 2),
  micro: t(fonts.semibold, 12, 16, 1.3),
  button: t(fonts.semibold, 16, 20, 1.5),
  buttonSm: t(fonts.semibold, 14, 18, 1.5),
  tab: t(fonts.semibold, 15, 20, 1.5),
} as const satisfies Record<string, TypeStyle>;

/** Escala de espaçamento em pt (ux.md §6.6): o nome é o valor. */
const space = {
  0: 0,
  2: 2,
  4: 4,
  6: 6,
  8: 8,
  12: 12,
  16: 16,
  20: 20,
  24: 24,
  32: 32,
  40: 40,
  48: 48,
  64: 64,
} as const;

const layout = {
  screenX: 16,
  authX: 32,
  fieldGap: 8,
  headerHeight: 52,
  topTabsHeight: 44,
  bottomBarHeight: 50,
  postHeaderHeight: 56,
  actionsRowHeight: 44,
  rowMinHeight: 64,
  gridGap: 2,
  hitMin: 44,
} as const;

const radius = {
  sm: 6,
  md: 10,
  lg: 12,
  xl: 16,
  sheet: 20,
  full: 9999,
} as const;

const size = {
  avatar: { xs: 24, sm: 32, md: 36, lg: 44, xl: 48, '2xl': 64, '3xl': 72, profile: 86 },
  icon: { inline: 16, sm: 20, md: 24, lg: 28 },
  iconStroke: { regular: 2, active: 2.75 },
  button: { lg: 44, sm: 34 },
  input: 46,
  searchBar: 36,
  avatarRing: { gap: 2, stroke: 1.5 },
  unreadDot: 8,
  tabIndicator: 2,
  carouselDot: 6,
  progressBar: 2,
} as const;

/** Sombras via `boxShadow` (RN 0.76+, New Architecture), ux.md §6.9. */
const shadow = {
  sm: '0 1px 3px rgba(0,0,0,0.10)',
  md: '0 4px 12px rgba(0,0,0,0.15)',
  sheet: '0 -2px 16px rgba(0,0,0,0.12)',
  icon: '0 1px 2px rgba(0,0,0,0.5)',
} as const;

/** Durações em ms (ux.md §6.10). Com "Reduzir movimento", viram 0. */
const motion = {
  fast: 120,
  base: 200,
  slow: 300,
  heart: 300,
  radarCycle: 2400,
  toastVisible: 4000,
  toastVisibleWithAction: 6000,
  /** Easing padrão: Easing.bezier(0.2, 0, 0, 1). */
  easing: [0.2, 0, 0, 1],
} as const;

const opacity = {
  pressed: 0.7,
  disabled: 0.4,
} as const;

export const theme = {
  colors,
  avatarPalette,
  fonts,
  type,
  space,
  layout,
  radius,
  size,
  shadow,
  motion,
  opacity,
} as const;

export type Theme = typeof theme;
export type ColorToken = keyof typeof colors;
export type BrandColorToken = keyof typeof brandColors;
export type TypeToken = keyof typeof type;
export type SpaceToken = keyof typeof space;
export type AvatarSize = (typeof size.avatar)[keyof typeof size.avatar];

/** Os 9 tokens do PO, para quem precisar listar só a paleta original (catálogo, testes). */
export const brandColorTokens = Object.keys(brandColors) as BrandColorToken[];
