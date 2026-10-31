import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { Text } from '../Text/Text';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface ToastProps {
  message: string;
  variant?: ToastVariant;
  action?: ToastAction;
  /**
   * Região viva do Android (padrão). `false` quando o anúncio sai por outro caminho (o
   * `announceAfterMs` do `ToastProvider`), para não anunciar duas vezes.
   */
  live?: boolean;
  testID?: string;
}

/** Aparência do Toast (ux.md §6.13). A fila e o tempo ficam no `ToastProvider`. */
export function Toast({
  message,
  variant = 'info',
  action,
  live = true,
  testID = 'toast',
}: ToastProps) {
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion={live ? 'polite' : 'none'}
      style={styles.toast}
    >
      {variant === 'success' ? <Icon name="check" size={16} color="white" /> : null}
      {variant === 'error' ? <Icon name="circle-alert" size={16} color="white" /> : null}
      <Text variant="bodySm" color="white" style={styles.message}>
        {message}
      </Text>
      {action === undefined ? null : (
        <Pressable
          testID={`${testID}-action`}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={10}
          onPress={action.onPress}
        >
          {/* Azul sobre ink falha no contraste (3,1:1): a ação usa blueMist (ux.md §7.1). */}
          <Text variant="buttonSm" color="blueMist">
            {action.label}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[8],
    backgroundColor: theme.colors.ink,
    borderRadius: theme.radius.lg,
    paddingVertical: theme.space[12],
    paddingHorizontal: theme.space[16],
    boxShadow: theme.shadow.md,
  },
  message: { flex: 1 },
});
