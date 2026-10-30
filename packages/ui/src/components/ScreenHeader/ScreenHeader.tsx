import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { Text } from '../Text/Text';

export interface HeaderTextAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Ação principal (azul, 600), ex.: "Concluir". */
  primary?: boolean;
}

export type ScreenHeaderProps =
  | {
      /** `‹` + título (p09/p17, ux.md §6.14). */
      variant: 'back';
      title: string;
      onBack: () => void;
      testID?: string;
    }
  | {
      /** Modal: ação de texto à esquerda, título central e ação à direita (ex.: Editar perfil). */
      variant: 'modal';
      title: string;
      left: HeaderTextAction;
      right?: HeaderTextAction;
      testID?: string;
    };

function TextAction({ action, align }: { action: HeaderTextAction; align: 'left' | 'right' }) {
  const disabled = action.disabled === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={action.onPress}
      style={({ pressed }) => [
        styles.side,
        align === 'right' && styles.right,
        pressed && styles.pressed,
      ]}
    >
      <Text
        variant={action.primary === true ? 'bodyStrong' : 'body'}
        color={disabled ? 'blueMist' : action.primary === true ? 'blue' : 'black'}
      >
        {action.label}
      </Text>
    </Pressable>
  );
}

/** Cabeçalho de 52 pt das telas empilhadas e modais (ux.md §6.14). */
export function ScreenHeader(props: ScreenHeaderProps) {
  const testID = props.testID ?? 'screen-header';
  if (props.variant === 'back') {
    return (
      <View testID={testID} style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Voltar"
          hitSlop={8}
          onPress={props.onBack}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Icon name="chevron-left" />
        </Pressable>
        <Text variant="titleSm" accessibilityRole="header" numberOfLines={1} style={styles.flex}>
          {props.title}
        </Text>
      </View>
    );
  }
  return (
    <View testID={testID} style={styles.bar}>
      <TextAction action={props.left} align="left" />
      <Text
        variant="titleSm"
        align="center"
        accessibilityRole="header"
        numberOfLines={1}
        style={styles.flex}
      >
        {props.title}
      </Text>
      {props.right === undefined ? (
        <View style={styles.side} />
      ) : (
        <TextAction action={props.right} align="right" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: theme.layout.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.layout.screenX,
    gap: theme.space[8],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.white,
  },
  flex: { flex: 1 },
  back: {
    width: theme.layout.hitMin,
    height: theme.layout.hitMin,
    marginLeft: -theme.space[12],
    alignItems: 'center',
    justifyContent: 'center',
  },
  side: { minWidth: 72, minHeight: theme.layout.hitMin, justifyContent: 'center' },
  right: { alignItems: 'flex-end' },
  pressed: { opacity: theme.opacity.pressed },
});
