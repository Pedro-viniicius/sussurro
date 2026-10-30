import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import { type ColorToken, theme } from '../../theme';
import { Icon, type IconName } from '../Icon/Icon';
import { Text } from '../Text/Text';

export type ButtonVariant = 'primary' | 'secondary' | 'link' | 'destructive';
export type ButtonSize = 'lg' | 'sm';

export interface ButtonProps {
  label: string;
  onPress: (event: GestureResponderEvent) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  /** Rótulo para o leitor de tela quando difere do texto (ex.: "Seguir @marinac"). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Força a aparência pressionada (só para o catálogo). */
  forcePressed?: boolean;
  testID?: string;
}

interface Look {
  background: ColorToken | 'transparent';
  text: ColorToken;
  border?: ColorToken;
}

function look(variant: ButtonVariant, pressed: boolean, disabled: boolean): Look {
  switch (variant) {
    case 'primary':
      if (disabled) return { background: 'blueMist', text: 'white' };
      return { background: pressed ? 'bluePressed' : 'blue', text: 'white' };
    case 'secondary':
      if (disabled) return { background: 'greySoft', text: 'grey' };
      return { background: pressed ? 'greySoftPressed' : 'greySoft', text: 'black' };
    case 'link':
      return { background: 'transparent', text: disabled ? 'blueMist' : 'blue' };
    case 'destructive':
      return {
        background: pressed ? 'greySoft' : 'white',
        text: disabled ? 'grey' : 'danger',
        border: 'border',
      };
  }
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  fullWidth = false,
  disabled = false,
  loading = false,
  icon,
  accessibilityLabel,
  accessibilityHint,
  forcePressed = false,
  testID,
}: ButtonProps) {
  const inactive = disabled || loading;
  const small = size === 'sm';

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      accessibilityState={{ disabled: inactive, busy: loading }}
      // Button sm tem 34 de altura: o hitSlop vertical completa o alvo de 44 (ux.md §7.2).
      hitSlop={small ? { top: 5, bottom: 5 } : undefined}
      style={({ pressed }) => {
        const colors = look(variant, (pressed || forcePressed) && !inactive, disabled);
        const style: ViewStyle = {
          minHeight: small ? theme.size.button.sm : theme.size.button.lg,
          borderRadius: small ? theme.radius.md : theme.radius.lg,
          paddingHorizontal: variant === 'link' ? 0 : theme.space[16],
          backgroundColor:
            colors.background === 'transparent' ? 'transparent' : theme.colors[colors.background],
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          ...(colors.border === undefined
            ? {}
            : { borderWidth: 1, borderColor: theme.colors[colors.border] }),
          ...(variant === 'link' && (pressed || forcePressed) && !inactive ? { opacity: 0.6 } : {}),
        };
        return [styles.base, style];
      }}
    >
      {({ pressed }) => {
        const colors = look(variant, (pressed || forcePressed) && !inactive, disabled);
        return (
          <View style={styles.content}>
            {/* Em loading o rótulo fica invisível, mas ocupa o espaço: a largura não muda. */}
            <View style={[styles.content, loading && styles.hidden]}>
              {icon === undefined ? null : (
                <Icon name={icon} size={small ? 16 : 20} color={colors.text} />
              )}
              <Text variant={small ? 'buttonSm' : 'button'} color={colors.text}>
                {label}
              </Text>
            </View>
            {loading ? (
              <ActivityIndicator
                testID={testID === undefined ? undefined : `${testID}-spinner`}
                style={StyleSheet.absoluteFill}
                color={variant === 'primary' ? theme.colors.white : theme.colors.black}
              />
            ) : null}
          </View>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  hidden: { opacity: 0 },
});
