import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { useFontScale } from '../../preferences';
import { type ColorToken, theme, type TypeToken } from '../../theme';

export interface TextProps extends RNTextProps {
  /** Token tipográfico (ux.md §6.4). Resolve a família pelo peso (necessário no Android). */
  variant?: TypeToken;
  color?: ColorToken;
  align?: TextStyle['textAlign'];
  /** Números alinhados (contadores, durações). */
  tabularNums?: boolean;
}

/** Texto do design system. Nunca usar `fontWeight` solto: o peso vem da família. */
export function Text({
  variant = 'body',
  color = 'black',
  align,
  tabularNums = false,
  style,
  maxFontSizeMultiplier,
  ...rest
}: TextProps) {
  const fontScale = useFontScale();
  const token = theme.type[variant];
  const base: TextStyle = {
    fontFamily: token.fontFamily,
    fontSize: token.fontSize * fontScale,
    lineHeight: token.lineHeight * fontScale,
    letterSpacing: token.letterSpacing,
    color: theme.colors[color],
    ...(align === undefined ? {} : { textAlign: align }),
    ...(tabularNums ? { fontVariant: ['tabular-nums' as const] } : {}),
  };
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? token.maxFontSizeMultiplier}
      style={[base, style]}
      {...rest}
    />
  );
}
