import { Pressable, StyleSheet, View } from 'react-native';

import { type ColorToken, theme } from '../../theme';
import { Icon, type IconName } from '../Icon/Icon';

export interface IconButtonProps {
  icon: IconName;
  /** Obrigatório: o ícone sozinho não diz nada ao leitor de tela (ux.md §6.14). */
  accessibilityLabel: string;
  onPress: () => void;
  size?: number;
  color?: ColorToken;
  active?: boolean;
  filled?: boolean;
  disabled?: boolean;
  selected?: boolean;
  /**
   * Ponto azul de novidades sobre o ícone (coração do Início, 6.2). Só visual: quem usa põe
   * ", há novidades" no rótulo (ux.md §7).
   */
  dot?: boolean;
  testID?: string;
}

/** Ícone em área de toque 44×44 (headers, posts). */
export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = theme.size.icon.md,
  color = 'black',
  active = false,
  filled = false,
  disabled = false,
  selected,
  dot = false,
  testID,
}: IconButtonProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <View>
        <Icon name={icon} size={size} color={color} active={active} filled={filled} />
        {dot ? <View testID={`${testID ?? 'icon-button'}-dot`} style={styles.dot} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: theme.layout.hitMin,
    minHeight: theme.layout.hitMin,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: theme.opacity.pressed },
  // O mesmo ponto da aba Notificações do criador (BottomTabBar).
  dot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: theme.size.unreadDot,
    height: theme.size.unreadDot,
    borderRadius: theme.size.unreadDot / 2,
    backgroundColor: theme.colors.blue,
    borderWidth: 1.5,
    borderColor: theme.colors.white,
  },
});
