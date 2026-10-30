import { type AccessibilityRole, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import {
  LOGO_ARC_1,
  LOGO_ARC_2,
  LOGO_DOT,
  LOGO_STROKE_WIDTH,
  LOGO_VIEWBOX,
  logoColors,
  type LogoTone,
} from './geometry';
import { theme } from '../../theme';
import { Text } from '../Text/Text';

export interface LogoProps {
  variant?: 'mark' | 'lockup';
  tone?: LogoTone;
  /** Altura do símbolo em pt. Mínimo 16 (ux.md §6.12). */
  size?: number;
  /** Só no lockup: símbolo ao lado (`row`) ou acima (`stacked`) do wordmark. */
  layout?: 'row' | 'stacked';
  accessibilityLabel?: string;
  /** `header` quando o lockup é o título da tela (header do feed). */
  accessibilityRole?: AccessibilityRole;
  testID?: string;
}

const MIN_SIZE = 16;

export function Logo({
  variant = 'mark',
  tone = 'default',
  size = 32,
  layout = 'row',
  accessibilityLabel = 'Sussurro',
  accessibilityRole = 'image',
  testID = 'logo',
}: LogoProps) {
  const markSize = Math.max(MIN_SIZE, size);
  const colors = logoColors(tone);

  const mark = (
    <Svg width={markSize} height={markSize} viewBox={LOGO_VIEWBOX} testID={`${testID}-mark`}>
      <Path
        testID={`${testID}-arc-1`}
        d={LOGO_ARC_1}
        stroke={colors.arc1}
        strokeWidth={LOGO_STROKE_WIDTH}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        testID={`${testID}-arc-2`}
        d={LOGO_ARC_2}
        stroke={colors.arc2}
        strokeWidth={LOGO_STROKE_WIDTH}
        strokeLinecap="round"
        fill="none"
      />
      <Circle
        testID={`${testID}-dot`}
        cx={LOGO_DOT.cx}
        cy={LOGO_DOT.cy}
        r={LOGO_DOT.r}
        fill={colors.dot}
      />
    </Svg>
  );

  const stacked = variant === 'lockup' && layout === 'stacked';
  // Empilhado (Entrar/Cadastro, p01): símbolo 64 com wordmark de 40 pt (ux.md §6.12).
  const wordmarkSize = stacked ? markSize * 0.625 : markSize * 0.95;
  const containerStyle: ViewStyle = stacked
    ? { alignItems: 'center', gap: markSize * 0.25 }
    : { flexDirection: 'row', alignItems: 'center', gap: markSize * 0.25 };

  return (
    <View
      accessible
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={variant === 'lockup' ? containerStyle : styles.mark}
    >
      {mark}
      {variant === 'lockup' ? (
        <Text
          testID={`${testID}-wordmark`}
          allowFontScaling={false}
          style={{
            fontFamily: theme.fonts.wordmark,
            fontSize: wordmarkSize,
            lineHeight: wordmarkSize * 1.15,
            letterSpacing: -0.02 * wordmarkSize,
            color: colors.wordmark,
          }}
        >
          sussurro
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { alignSelf: 'flex-start' },
});
